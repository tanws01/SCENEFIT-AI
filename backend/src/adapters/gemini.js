'use strict';

/**
 * Gemini adapter (Google Generative AI).
 *
 * ARCHITECTURAL PRINCIPLE (enforced here):
 *   "Gemini generates understanding and recommendations;
 *    the application validates retail facts."
 *
 * This adapter is responsible ONLY for language understanding and styling
 * suggestions. Its output is UNTRUSTED. It returns:
 *   - parseIntent()    : a structured interpretation of the shopper utterance.
 *   - proposeOutfits() : outfit CONCEPTS (names, slot roles, candidate SKU
 *                        references, styling rationale) only.
 *   - explainOutfit()  : natural-language rationale for an assembled outfit.
 *
 * Gemini must NEVER emit authoritative retail facts: price, stock,
 * availability, size availability, budget compliance, rack location, queue
 * confirmation, or collection dates. Those are owned by deterministic
 * application services that validate against the seeded catalogue/inventory.
 *
 * The "mock" path is fully deterministic (no randomness, no network) so the
 * whole system runs offline. The "live" path is a clearly-marked TODO stub
 * that lazily requires the Google SDK inside the function body, so module load
 * never fails offline when the SDK is absent.
 */

/** Fields the application layer owns. Gemini concepts must never carry them. */
const FORBIDDEN_RETAIL_FIELDS = Object.freeze([
  'price',
  'priceRm',
  'stock',
  'inventory',
  'availability',
  'available',
  'sizeAvailability',
  'budgetCompliant',
  'rack',
  'rackLocation',
  'location',
  'queue',
  'queueConfirmation',
  'arrivalDate',
  'releaseDate',
  'collectionDate',
]);

const OCCASION_KEYWORDS = Object.freeze({
  beach: ['beach', 'seaside', 'batu ferringhi', 'batu feringghi', 'port dickson', 'seafront', 'coast'],
  getaway: ['getaway', 'trip', 'vacation', 'holiday', 'weekend away'],
  dinner: ['dinner', 'date night', 'date', 'evening out'],
  work: ['work', 'office', 'meeting', 'business'],
  wedding: ['wedding', 'reception', 'engagement'],
  casual: ['casual', 'hangout', 'everyday', 'relaxed day'],
});

/**
 * Deterministic destination/scene keyword map. Keyed off the SAME utterance as
 * occasions/styles, this picks an illustrative background scene for the Shop
 * page. It is a model-side interpretation (a parse of the words), NOT a retail
 * fact: it carries no price/stock/location/queue/date. `place` preserves the
 * specific matched place name (e.g. 'batu ferringhi') so the UI can show it.
 *
 * Ordering matters: the first entry whose keyword matches wins, so more
 * specific scenes (place-driven beach, resort getaways) are listed before
 * broader occasion scenes. Each entry can mark `places` - specific place names
 * that, when matched, are preserved verbatim in scene.place.
 */
const SCENE_KEYWORDS = Object.freeze([
  {
    id: 'beach',
    label: 'Beach / seaside',
    keywords: ['batu ferringhi', 'batu feringghi', 'beach', 'seaside', 'port dickson', 'seafront', 'coast'],
    places: ['batu ferringhi', 'batu feringghi', 'port dickson'],
  },
  {
    id: 'resort',
    label: 'Resort getaway',
    keywords: ['resort', 'getaway', 'holiday', 'vacation', 'poolside'],
    places: [],
  },
  {
    id: 'wedding',
    label: 'Wedding / reception',
    keywords: ['wedding', 'reception', 'engagement'],
    places: [],
  },
  {
    id: 'dinner',
    label: 'Evening dinner',
    keywords: ['dinner', 'date night', 'date', 'evening out', 'evening'],
    places: [],
  },
  {
    id: 'urban',
    label: 'Urban / work',
    keywords: ['work', 'office', 'meeting', 'business', 'city'],
    places: [],
  },
]);

const DEFAULT_SCENE = Object.freeze({ id: 'studio', label: 'Studio backdrop' });

/**
 * Deterministically derive a `scene` from the utterance text. Returns an object
 * { id, label, place?, source }. Unknown/none falls back to the studio scene.
 * No randomness, no network, no retail facts.
 * @param {string} text lower-cased utterance
 */
function deriveScene(text) {
  const lower = String(text || '').toLowerCase();
  for (const scene of SCENE_KEYWORDS) {
    const matched = scene.keywords.find((w) => lower.includes(w));
    if (!matched) continue;
    const out = { id: scene.id, label: scene.label, source: 'gemini-mock' };
    // Preserve the specific matched place string when present.
    const place = (scene.places || []).find((p) => lower.includes(p));
    if (place) out.place = place;
    return out;
  }
  return { id: DEFAULT_SCENE.id, label: DEFAULT_SCENE.label, source: 'gemini-mock' };
}

const STYLE_KEYWORDS = Object.freeze({
  'relaxed-tailoring': ['relaxed tailoring', 'relaxed-tailoring', 'smart casual', 'tailored but comfy'],
  streetwear: ['streetwear', 'street style', 'urban', 'hype'],
  minimalist: ['minimalist', 'minimal', 'clean', 'simple'],
  resort: ['resort', 'vacation wear', 'holiday wear'],
  sporty: ['sporty', 'athleisure', 'active'],
});

const COLOUR_KEYWORDS = Object.freeze([
  'black', 'white', 'navy', 'blue', 'beige', 'cream', 'khaki', 'olive',
  'green', 'brown', 'grey', 'gray', 'red', 'pink', 'yellow', 'orange',
  'linen', 'denim', 'pastel', 'earth tone', 'earth tones', 'neutral',
]);

/**
 * Deterministically parse a shopper utterance into a structured intent.
 * No authoritative retail facts are produced - only an interpretation.
 * @param {string} utterance
 * @param {object} [profile]
 * @returns {object} structured intent
 */
function mockParseIntent(utterance, profile = {}) {
  const text = String(utterance || '').toLowerCase();

  // Entry point: occasion-driven ("style my moment") vs latest-collection.
  const latestSignals = ['latest', 'new arrival', 'new arrivals', "what's new", 'whats new', 'just dropped', 'newest'];
  const wantsLatest = latestSignals.some((s) => text.includes(s));

  const occasions = [];
  for (const [occasion, words] of Object.entries(OCCASION_KEYWORDS)) {
    if (words.some((w) => text.includes(w))) occasions.push(occasion);
  }

  const styles = [];
  for (const [style, words] of Object.entries(STYLE_KEYWORDS)) {
    if (words.some((w) => text.includes(w))) styles.push(style);
  }

  const colours = COLOUR_KEYWORDS.filter((c) => text.includes(c));

  // Budget: capture "RM250", "rm 300", "under 250 ringgit", "budget of 300".
  let budgetRm = null;
  const budgetMatch = text.match(/(?:rm|ringgit)\s*([0-9]{2,5})|([0-9]{2,5})\s*(?:rm|ringgit)|budget[^0-9]{0,12}([0-9]{2,5})|under[^0-9]{0,8}([0-9]{2,5})/);
  if (budgetMatch) {
    const amount = budgetMatch[1] || budgetMatch[2] || budgetMatch[3] || budgetMatch[4];
    if (amount) budgetRm = Number(amount);
  }

  // Activities mentioned (free-form extraction of a few known ones).
  const activityKeywords = ['swimming', 'dinner', 'walking', 'sightseeing', 'photos', 'party', 'brunch', 'strolling'];
  const activities = activityKeywords.filter((a) => text.includes(a));

  // Sizes: "size M", "medium", "size 32", "UK 10".
  const sizes = [];
  const letterSize = text.match(/\bsize\s*(xs|s|m|l|xl|xxl)\b/);
  if (letterSize) sizes.push(letterSize[1].toUpperCase());
  const wordSize = text.match(/\b(small|medium|large)\b/);
  if (wordSize) {
    sizes.push({ small: 'S', medium: 'M', large: 'L' }[wordSize[1]]);
  }
  const numericSize = text.match(/\bsize\s*([0-9]{1,2})\b/);
  if (numericSize) sizes.push(numericSize[1]);

  // Deterministic illustrative scene for the Shop page background. A parse of
  // the utterance only - not a retail fact (no price/stock/location/queue/date).
  const scene = deriveScene(text);

  return {
    rawUtterance: String(utterance || ''),
    entryPoint: wantsLatest ? 'explore-whats-new' : 'style-my-moment',
    wantsLatestCollection: wantsLatest,
    occasions,
    activities,
    styles,
    colours,
    scene,
    sizes: Array.from(new Set(sizes)),
    budget: budgetRm != null ? { amountRm: budgetRm, currency: 'RM' } : null,
    profileHints: {
      preferredSizes: Array.isArray(profile.preferredSizes) ? profile.preferredSizes : [],
      preferredColours: Array.isArray(profile.preferredColours) ? profile.preferredColours : [],
    },
    // Confidence is a model-side notion only; it is NOT a retail fact.
    confidence: occasions.length || styles.length || wantsLatest ? 0.9 : 0.5,
    source: 'gemini-mock',
  };
}

/**
 * Strip any field the application layer owns, in case a caller (or a future
 * live model) tries to smuggle a retail fact into a concept. Defensive.
 * @param {object} obj
 */
function stripRetailFields(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const clone = Array.isArray(obj) ? [] : {};
  for (const [key, value] of Object.entries(obj)) {
    const lower = key.toLowerCase();
    if (FORBIDDEN_RETAIL_FIELDS.some((f) => lower === f.toLowerCase())) continue;
    clone[key] = value && typeof value === 'object' ? stripRetailFields(value) : value;
  }
  return clone;
}

/**
 * Propose outfit CONCEPTS from the parsed intent and a candidate pool of SKU
 * references. The candidate pool is supplied by the application (which has
 * already filtered to valid, catalogue-backed SKUs). Gemini only arranges the
 * candidates into coherent concepts and explains why - it does not vouch for
 * price, stock, or availability.
 *
 * @param {object} intent  result of parseIntent
 * @param {Array<{sku:string, category:string, colour?:string, name?:string}>} candidatePool
 * @returns {Array<object>} outfit concepts (no retail facts)
 */
function mockProposeOutfits(intent, candidatePool = []) {
  const pool = Array.isArray(candidatePool) ? candidatePool : [];

  const byCategory = (cat) => pool.filter((c) => (c.category || '').toLowerCase() === cat);
  const tops = byCategory('top');
  const bottoms = byCategory('bottom');
  const footwear = byCategory('footwear');
  const outerwear = byCategory('outerwear');
  const accessories = byCategory('accessory');

  const theme = intent && intent.wantsLatestCollection ? 'latest-arrivals' : 'occasion';
  const styleLabel = intent && intent.styles && intent.styles.length
    ? intent.styles[0]
    : (theme === 'latest-arrivals' ? 'relaxed-tailoring' : 'effortless');

  const conceptNames = [
    `${capitalize(styleLabel)} Anchor Look`,
    `${capitalize(styleLabel)} Layered Look`,
    `${capitalize(styleLabel)} Statement Look`,
  ];

  // Build up to three deterministic concept arrangements by rotating the pool.
  const concepts = [];
  const maxConcepts = Math.min(3, Math.max(tops.length, bottoms.length, 1));
  for (let i = 0; i < maxConcepts; i += 1) {
    const slots = [];
    const pick = (arr, idx) => (arr.length ? arr[idx % arr.length] : null);

    const top = pick(tops, i);
    const bottom = pick(bottoms, i);
    const shoes = pick(footwear, i);
    const outer = pick(outerwear, i);
    const acc = pick(accessories, i);

    if (top) slots.push({ role: 'top', candidateSku: top.sku, note: 'core piece' });
    if (bottom) slots.push({ role: 'bottom', candidateSku: bottom.sku, note: 'pairs with the top' });
    if (shoes) slots.push({ role: 'footwear', candidateSku: shoes.sku, note: 'completes the silhouette' });
    if (i === 1 && outer) slots.push({ role: 'outerwear', candidateSku: outer.sku, note: 'light layer' });
    if (i === 2 && acc) slots.push({ role: 'accessory', candidateSku: acc.sku, note: 'finishing accent' });

    if (slots.length === 0) continue;

    concepts.push({
      conceptId: `concept-${i + 1}`,
      name: conceptNames[i] || `Look ${i + 1}`,
      theme,
      styleLabel,
      slots,
      rationale: buildRationale(intent, styleLabel, theme),
      // Explicit boundary marker so downstream code knows this is a suggestion.
      isSuggestion: true,
      source: 'gemini-mock',
    });
  }

  // Defensive: ensure no retail fact leaked into any concept.
  return concepts.map(stripRetailFields);
}

function buildRationale(intent, styleLabel, theme) {
  const parts = [];
  if (theme === 'latest-arrivals') {
    parts.push('Built around current new-arrival pieces');
  } else if (intent && intent.occasions && intent.occasions.length) {
    parts.push(`Suited to a ${intent.occasions.join(' / ')} occasion`);
  } else {
    parts.push('An easy, coordinated look');
  }
  parts.push(`with a ${styleLabel} feel`);
  if (intent && intent.colours && intent.colours.length) {
    parts.push(`in your ${intent.colours.join(', ')} palette`);
  }
  return `${parts.join(' ')}.`;
}

/**
 * Produce a natural-language explanation for an already-assembled outfit.
 * Takes only descriptive, non-authoritative inputs.
 * @param {object} outfitConcept
 * @returns {{conceptId:string, explanation:string, source:string}}
 */
function mockExplainOutfit(outfitConcept = {}) {
  const name = outfitConcept.name || 'this look';
  const rationale = outfitConcept.rationale || 'The pieces share a consistent tone and silhouette.';
  return {
    conceptId: outfitConcept.conceptId || null,
    explanation: `${name}: ${rationale} The pieces are chosen to layer and mix easily for the moment you described.`,
    source: 'gemini-mock',
  };
}

function capitalize(s) {
  const str = String(s || '');
  return str.charAt(0).toUpperCase() + str.slice(1);
}

/**
 * Factory. Returns a common interface regardless of mode.
 * @param {{mode?: 'mock'|'live', config?: object}} [opts]
 */
function createGemini(opts = {}) {
  const mode = opts.mode === 'live' ? 'live' : 'mock';

  if (mode === 'live') {
    return {
      mode,
      async parseIntent(utterance, profile) {
        return liveNotImplemented('parseIntent', { utterance, profile });
      },
      async proposeOutfits(intent, candidatePool) {
        return liveNotImplemented('proposeOutfits', { intent, candidatePool });
      },
      async explainOutfit(outfitConcept) {
        return liveNotImplemented('explainOutfit', { outfitConcept });
      },
    };
  }

  // Mock mode: deterministic, offline. Wrapped in Promise-returning methods so
  // the interface matches the live (async) adapter.
  return {
    mode,
    async parseIntent(utterance, profile) {
      return mockParseIntent(utterance, profile);
    },
    async proposeOutfits(intent, candidatePool) {
      return mockProposeOutfits(intent, candidatePool);
    },
    async explainOutfit(outfitConcept) {
      return mockExplainOutfit(outfitConcept);
    },
  };
}

/**
 * Live-mode TODO stub. Never reached offline. Lazily requires the Google SDK
 * so module load never fails when the package is absent.
 * @param {string} method
 */
function liveNotImplemented(method /*, args */) {
  // TODO(live): Call Google Gemini via the Generative Language API or Vertex AI.
  //   Endpoint: https://generativelanguage.googleapis.com/v1/models/{model}:generateContent
  //            (or Vertex AI: {location}-aiplatform.googleapis.com)
  //   Env vars: GEMINI_API_KEY (from Secret Manager), GEMINI_MODEL,
  //             GOOGLE_CLOUD_PROJECT, VERTEX_LOCATION.
  //   Lazy require keeps module load safe offline:
  //     const { GoogleGenerativeAI } = require('@google/generative-ai');
  //   The live model MUST be prompted to return concepts only; the application
  //   still validates all retail facts regardless of model output.
  throw new Error(
    `gemini live mode not implemented in MVP (method: ${method}). ` +
    'Configure GEMINI_MODE=live with Google Gemini credentials in a deployed environment.'
  );
}

module.exports = {
  createGemini,
  FORBIDDEN_RETAIL_FIELDS,
  SCENE_KEYWORDS,
  // Exported for unit tests of the deterministic logic.
  _mock: { mockParseIntent, mockProposeOutfits, mockExplainOutfit, stripRetailFields, deriveScene },
};
