'use strict';

/**
 * Conversation session service - F01 / F02.
 *
 * Manages a shopping conversation:
 *   - accepts typed text OR a voice ref (transcribed via the Speech-to-Text
 *     adapter) and runs Gemini parseIntent (untrusted interpretation);
 *   - supports conversational REFINEMENT ("make it more casual, keep the
 *     shoes") by merging deltas into the prior intent WITHOUT losing the
 *     original mandatory constraints (especially budget);
 *   - supports SWITCHING intent (occasion <-> latest-collection) mid-chat;
 *   - asks a targeted follow-up ONLY when a mandatory slot is missing.
 *
 * Sessions are held in-memory (deterministic) and also mirrored to Firestore so
 * a deployed environment can persist them. The intent is a Gemini suggestion;
 * all retail facts remain owned by the deterministic services downstream.
 */

const SESSION_COLLECTION = 'conversationSessions';

/** Keywords that signal a refinement should keep a given role from before. */
const KEEP_PATTERNS = [
  { role: 'footwear', re: /keep (the )?(shoes|sneakers|footwear|loafers|sandals)/i },
  { role: 'top', re: /keep (the )?(top|shirt|tee)/i },
  { role: 'bottom', re: /keep (the )?(bottom|trousers|pants|shorts|jeans)/i },
];

/**
 * @param {object} deps
 * @param {object} deps.gemini gemini adapter (parseIntent)
 * @param {object} deps.speech speech-to-text adapter
 * @param {object} [deps.firestore] firestore adapter (session persistence)
 */
function createConversation(deps = {}) {
  const gemini = deps.gemini;
  const speech = deps.speech;
  if (!gemini) throw new Error('conversation requires a gemini adapter');
  if (!speech) throw new Error('conversation requires a speech adapter');
  const firestore = deps.firestore || null;

  /** @type {Map<string, object>} */
  const sessions = new Map();
  let counter = 0;

  function newSessionId() {
    counter += 1;
    return `sess-${counter}`;
  }

  async function persist(session) {
    if (firestore) {
      try { await firestore.set(SESSION_COLLECTION, session.id, session); } catch (_e) { /* best effort */ }
    }
    sessions.set(session.id, session);
    return session;
  }

  /** Create a new conversation session. */
  async function startSession(opts = {}) {
    const session = {
      id: opts.sessionId || newSessionId(),
      userId: opts.userId || null,
      intent: null,
      keptRoles: [],
      history: [],
      createdAt: deterministicStamp(counter),
    };
    return persist(session);
  }

  async function getSession(sessionId) {
    if (sessions.has(sessionId)) return sessions.get(sessionId);
    if (firestore) {
      const stored = await firestore.get(SESSION_COLLECTION, sessionId);
      if (stored) { sessions.set(sessionId, stored); return stored; }
    }
    return null;
  }

  /**
   * Resolve an utterance from either text or a voice ref.
   * @param {{text?:string, voiceRef?:string}} input
   * @returns {Promise<{utterance:string, inputMode:'text'|'voice', transcript?:object}>}
   */
  async function resolveUtterance(input = {}) {
    if (input.voiceRef) {
      const transcript = await speech.transcribe(input.voiceRef);
      return { utterance: transcript.transcript, inputMode: 'voice', transcript };
    }
    return { utterance: String(input.text || ''), inputMode: 'text' };
  }

  /**
   * Handle a new message (text or voice) - parses a fresh intent, supporting
   * intent switching (the newly parsed entryPoint simply replaces the old one).
   *
   * @param {string} sessionId
   * @param {{text?:string, voiceRef?:string, profile?:object}} input
   */
  async function handleMessage(sessionId, input = {}) {
    const session = (await getSession(sessionId)) || (await startSession({ sessionId }));
    const { utterance, inputMode, transcript } = await resolveUtterance(input);
    const intent = await gemini.parseIntent(utterance, input.profile || {});

    session.intent = intent;
    session.keptRoles = [];
    session.history.push({ type: inputMode, utterance });
    await persist(session);

    const followUp = missingMandatorySlot(intent);
    return {
      sessionId: session.id,
      intent,
      inputMode,
      transcript: transcript || null,
      followUp,
      intentSwitched: false,
    };
  }

  /**
   * Handle a conversational refinement. Merges deltas into the PRIOR intent and
   * preserves mandatory constraints (budget stays unless the shopper explicitly
   * changes it). Honours "keep the X" directives.
   *
   * @param {string} sessionId
   * @param {{text?:string, voiceRef?:string, profile?:object}} input
   */
  async function handleRefine(sessionId, input = {}) {
    const session = await getSession(sessionId);
    if (!session || !session.intent) {
      // No prior turn -> treat as a fresh message.
      return handleMessage(sessionId, input);
    }
    const prior = session.intent;
    const { utterance, inputMode, transcript } = await resolveUtterance(input);
    const delta = await gemini.parseIntent(utterance, input.profile || {});

    // Detect "keep the shoes / top / bottom" directives.
    const keptRoles = detectKeptRoles(utterance);

    // Did the shopper explicitly switch entry point in this refinement?
    const switched = utterance && (
      /\b(latest|new arrival|new arrivals|what'?s new|just dropped)\b/i.test(utterance)
        !== prior.wantsLatestCollection
    ) && hasEntrySignal(utterance);

    const merged = mergeIntent(prior, delta, { switched, utterance });

    session.intent = merged;
    session.keptRoles = Array.from(new Set([...(session.keptRoles || []), ...keptRoles]));
    session.history.push({ type: `refine:${inputMode}`, utterance });
    await persist(session);

    return {
      sessionId: session.id,
      intent: merged,
      keptRoles: session.keptRoles,
      inputMode,
      transcript: transcript || null,
      followUp: missingMandatorySlot(merged),
      intentSwitched: Boolean(switched),
    };
  }

  return { startSession, getSession, handleMessage, handleRefine, resolveUtterance };
}

/* ----------------------------- intent merge ------------------------------ */

/**
 * Merge a refinement delta into a prior intent. Rules:
 *   - BUDGET is mandatory and preserved unless the delta explicitly carries a
 *     new budget (shopper changed it).
 *   - new styles/colours/occasions/activities/sizes override when present in
 *     the delta; otherwise the prior values are kept.
 *   - entryPoint/wantsLatestCollection switch only when the delta clearly
 *     signals it.
 */
function mergeIntent(prior, delta, ctx) {
  const merged = { ...prior };

  // Budget: keep prior unless delta explicitly provides one.
  merged.budget = (delta.budget && delta.budget.amountRm != null) ? delta.budget : prior.budget;

  // Lists: override when the delta provides any, else keep prior.
  // Styles override on a fresh style directive; occasions/colours/activities
  // merge additively so a refinement keeps the original trip context.
  merged.styles = nonEmpty(delta.styles) ? dedupe([].concat(prior.styles || [], delta.styles)) : prior.styles;
  merged.colours = nonEmpty(delta.colours) ? dedupe([].concat(prior.colours || [], delta.colours)) : prior.colours;
  merged.occasions = nonEmpty(delta.occasions) ? dedupe([].concat(prior.occasions || [], delta.occasions)) : prior.occasions;
  merged.activities = nonEmpty(delta.activities) ? dedupe([].concat(prior.activities || [], delta.activities)) : prior.activities;
  merged.sizes = nonEmpty(delta.sizes) ? dedupe(delta.sizes) : prior.sizes;

  // Entry point / latest-collection switch only on a clear signal.
  if (ctx && ctx.switched) {
    merged.wantsLatestCollection = delta.wantsLatestCollection;
    merged.entryPoint = delta.entryPoint;
  }

  merged.rawUtterance = `${prior.rawUtterance} || ${delta.rawUtterance}`.trim();
  merged.source = 'gemini-mock(refined)';
  return merged;
}

function detectKeptRoles(utterance) {
  const roles = [];
  for (const { role, re } of KEEP_PATTERNS) {
    if (re.test(String(utterance || ''))) roles.push(role);
  }
  return roles;
}

function hasEntrySignal(utterance) {
  return /\b(latest|new arrival|new arrivals|what'?s new|just dropped|occasion|wedding|dinner|beach|getaway)\b/i.test(String(utterance || ''));
}

/**
 * A mandatory slot is missing when we cannot proceed without a targeted
 * follow-up. For an occasion request with no budget and no occasion/style, ask.
 */
function missingMandatorySlot(intent) {
  if (!intent) return { field: 'intent', question: 'What are you shopping for today?' };
  const hasDirection = intent.wantsLatestCollection
    || nonEmpty(intent.occasions)
    || nonEmpty(intent.styles);
  if (!hasDirection) {
    return {
      field: 'direction',
      question: 'Are you styling for a specific occasion, or exploring the latest arrivals?',
    };
  }
  if (!intent.budget || intent.budget.amountRm == null) {
    return {
      field: 'budget',
      question: 'Do you have a budget in mind so I keep every look within it?',
    };
  }
  return null;
}

function nonEmpty(list) { return Array.isArray(list) && list.length > 0; }
function dedupe(list) { return Array.from(new Set((list || []).filter(Boolean))); }

function deterministicStamp(n) {
  // Fixed epoch + counter keeps session timestamps deterministic for tests.
  const base = Date.UTC(2025, 0, 1, 0, 0, 0);
  return new Date(base + n * 1000).toISOString();
}

module.exports = { createConversation };
