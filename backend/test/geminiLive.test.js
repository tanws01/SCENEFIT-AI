'use strict';

/**
 * Unit tests for the LIVE Gemini adapter (Google AI Studio / Generative
 * Language API). These run fully offline: Node 22's global `fetch` is stubbed
 * per-test and restored afterwards, so no real network call is ever made.
 *
 * The suite enforces the architectural boundary: the model's output is
 * untrusted. Retail facts are stripped, invented SKUs are dropped, the scene
 * is always deterministic, and any HTTP/parse failure falls back to the
 * deterministic mock rather than throwing.
 */

const { test } = require('node:test');
const assert = require('node:assert');

const { loadConfig } = require('../src/config');
const { createGemini } = require('../src/adapters/gemini');
const { _mock } = require('../src/adapters/gemini');

const LIVE_CONFIG = loadConfig({ GEMINI_MODE: 'live', GEMINI_API_KEY: 'test-key-123' });

/**
 * Install a fake global.fetch that returns a Generative Language API shaped
 * response whose candidate text is `modelText`. Returns a restore function.
 * If `modelText` is a function it is invoked with the request url+body so the
 * test can assert on the outgoing request.
 */
function stubFetch(modelText, { ok = true, status = 200, throwTransport = false } = {}) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    if (throwTransport) throw new Error('simulated network failure');
    const text = typeof modelText === 'function' ? modelText(url, options) : modelText;
    return {
      ok,
      status,
      async json() {
        return {
          candidates: [{ content: { parts: [{ text }] } }],
        };
      },
    };
  };
  return { restore: () => { globalThis.fetch = original; }, calls };
}

test('live parseIntent returns required shape and strips smuggled retail fields', async () => {
  const modelJson = JSON.stringify({
    entryPoint: 'style-my-moment',
    wantsLatestCollection: false,
    occasions: ['beach'],
    activities: ['swimming'],
    styles: ['resort'],
    colours: ['linen'],
    sizes: ['M'],
    budget: { amountRm: 250, currency: 'RM' },
    confidence: 0.9,
    // Smuggled retail facts the application owns - must be stripped.
    price: 199,
    stock: 7,
    availability: 'in-stock',
    rackLocation: 'A3',
  });
  const stub = stubFetch(modelJson);
  try {
    const gemini = createGemini({ mode: 'live', config: LIVE_CONFIG });
    const intent = await gemini.parseIntent('beach getaway in Port Dickson, budget RM250, size M', {});

    // Every required field present.
    for (const field of [
      'rawUtterance', 'entryPoint', 'wantsLatestCollection', 'occasions', 'activities',
      'styles', 'colours', 'scene', 'sizes', 'budget', 'profileHints', 'confidence', 'source',
    ]) {
      assert.ok(field in intent, `intent must include ${field}`);
    }
    assert.strictEqual(intent.source, 'gemini-live');
    assert.strictEqual(intent.budget.amountRm, 250);
    assert.strictEqual(intent.budget.currency, 'RM');

    // No forbidden retail field may survive anywhere in the returned object.
    const seen = new Set();
    const walk = (o) => {
      if (!o || typeof o !== 'object') return;
      for (const [k, v] of Object.entries(o)) { seen.add(k.toLowerCase()); walk(v); }
    };
    walk(intent);
    for (const forbidden of ['price', 'stock', 'availability', 'racklocation']) {
      assert.ok(!seen.has(forbidden), `retail field "${forbidden}" must be stripped`);
    }
  } finally {
    stub.restore();
  }
});

test('live parseIntent fills safe defaults when the model omits fields', async () => {
  const stub = stubFetch(JSON.stringify({ occasions: ['dinner'] }));
  try {
    const gemini = createGemini({ mode: 'live', config: LIVE_CONFIG });
    const intent = await gemini.parseIntent('dinner tonight', {});
    assert.strictEqual(intent.entryPoint, 'style-my-moment');
    assert.strictEqual(intent.wantsLatestCollection, false);
    assert.deepStrictEqual(intent.styles, []);
    assert.deepStrictEqual(intent.colours, []);
    assert.strictEqual(intent.budget, null);
    assert.ok(intent.confidence >= 0 && intent.confidence <= 1);
    assert.deepStrictEqual(intent.profileHints.preferredSizes, []);
  } finally {
    stub.restore();
  }
});

test('live scene stays deterministic (equals deriveScene) regardless of model output', async () => {
  // The model tries to override the scene with a bogus one; it must be ignored.
  const stub = stubFetch(JSON.stringify({
    occasions: ['beach'],
    scene: { id: 'INVENTED', label: 'model made this up', price: 9 },
  }));
  try {
    const gemini = createGemini({ mode: 'live', config: LIVE_CONFIG });
    const utterance = 'a beach day at Batu Ferringhi';
    const intent = await gemini.parseIntent(utterance, {});
    const expected = _mock.deriveScene(utterance.toLowerCase());
    assert.deepStrictEqual(intent.scene, expected);
    assert.strictEqual(intent.scene.id, 'beach');
    assert.strictEqual(intent.scene.place, 'batu ferringhi');
  } finally {
    stub.restore();
  }
});

test('live proposeOutfits drops slots whose candidateSku is not in the pool (no invented SKUs)', async () => {
  const pool = [
    { sku: 'TOP-LIN-001', category: 'top', colour: 'cream' },
    { sku: 'BOT-SHT-010', category: 'bottom', colour: 'khaki' },
    { sku: 'FTW-SND-020', category: 'footwear', colour: 'brown' },
  ];
  const modelJson = JSON.stringify({
    concepts: [
      {
        conceptId: 'c1', name: 'Coast Look', theme: 'occasion', styleLabel: 'resort',
        rationale: 'light tones', price: 500,
        slots: [
          { role: 'top', candidateSku: 'TOP-LIN-001', note: 'core' },
          { role: 'bottom', candidateSku: 'BOT-SHT-010', note: 'pairs' },
          // Invented SKU - must be dropped.
          { role: 'footwear', candidateSku: 'FAKE-SKU-999', note: 'hallucinated' },
        ],
      },
      {
        // Concept with only invented SKUs - should be dropped entirely.
        conceptId: 'c2', name: 'Ghost Look', slots: [
          { role: 'top', candidateSku: 'NOT-REAL-1' },
        ],
      },
    ],
  });
  const stub = stubFetch(modelJson);
  try {
    const gemini = createGemini({ mode: 'live', config: LIVE_CONFIG });
    const concepts = await gemini.proposeOutfits({ occasions: ['beach'] }, pool);

    assert.strictEqual(concepts.length, 1, 'empty concept should be dropped');
    const [c] = concepts;
    assert.strictEqual(c.source, 'gemini-live');
    assert.strictEqual(c.isSuggestion, true);
    const skus = c.slots.map((s) => s.candidateSku);
    assert.deepStrictEqual(skus.sort(), ['BOT-SHT-010', 'TOP-LIN-001']);
    for (const slot of c.slots) {
      assert.ok(pool.some((p) => p.sku === slot.candidateSku));
    }
    // No retail field smuggled through.
    assert.ok(!('price' in c));
  } finally {
    stub.restore();
  }
});

test('live proposeOutfits falls back to mock on HTTP failure', async () => {
  const pool = [
    { sku: 'TOP-LIN-001', category: 'top' },
    { sku: 'BOT-SHT-010', category: 'bottom' },
  ];
  const stub = stubFetch('irrelevant', { ok: false, status: 503 });
  try {
    const gemini = createGemini({ mode: 'live', config: LIVE_CONFIG });
    const intent = await gemini.parseIntent('something relaxed', {});
    const concepts = await gemini.proposeOutfits(intent, pool);
    assert.ok(Array.isArray(concepts) && concepts.length >= 1);
    // Fallback path uses the deterministic mock.
    assert.strictEqual(concepts[0].source, 'gemini-mock');
  } finally {
    stub.restore();
  }
});

test('live parseIntent falls back to mock on unparseable model response', async () => {
  const stub = stubFetch('this is not valid json {{{');
  try {
    const gemini = createGemini({ mode: 'live', config: LIVE_CONFIG });
    const intent = await gemini.parseIntent('beach getaway budget RM250 size M', {});
    // Fell back to deterministic mock, which still produces a valid intent.
    assert.strictEqual(intent.source, 'gemini-mock');
    assert.ok(intent.occasions.includes('beach'));
    assert.strictEqual(intent.budget.amountRm, 250);
    // Scene stays deterministic on the fallback path too.
    assert.deepStrictEqual(intent.scene, _mock.deriveScene('beach getaway budget rm250 size m'));
  } finally {
    stub.restore();
  }
});

test('live parseIntent falls back to mock on transport error', async () => {
  const stub = stubFetch(null, { throwTransport: true });
  try {
    const gemini = createGemini({ mode: 'live', config: LIVE_CONFIG });
    const intent = await gemini.parseIntent("what's new, streetwear, size L", {});
    assert.strictEqual(intent.source, 'gemini-mock');
    assert.strictEqual(intent.wantsLatestCollection, true);
  } finally {
    stub.restore();
  }
});

test('live explainOutfit returns prose and falls back on failure', async () => {
  // Success path (plain text, not JSON).
  const okStub = stubFetch('Light linen tones keep this easy and breathable for the coast.');
  try {
    const gemini = createGemini({ mode: 'live', config: LIVE_CONFIG });
    const out = await gemini.explainOutfit({ conceptId: 'concept-1', name: 'Coast Look' });
    assert.strictEqual(out.conceptId, 'concept-1');
    assert.strictEqual(out.source, 'gemini-live');
    assert.ok(out.explanation.length > 0);
  } finally {
    okStub.restore();
  }

  // Failure path -> mock fallback.
  const failStub = stubFetch(null, { throwTransport: true });
  try {
    const gemini = createGemini({ mode: 'live', config: LIVE_CONFIG });
    const out = await gemini.explainOutfit({ conceptId: 'concept-1', name: 'Coast Look' });
    assert.strictEqual(out.source, 'gemini-mock');
  } finally {
    failStub.restore();
  }
});

test('live mode with a missing API key surfaces a clear config error (no silent fallback)', async () => {
  const noKeyConfig = loadConfig({ GEMINI_MODE: 'live' }); // no GEMINI_API_KEY
  const gemini = createGemini({ mode: 'live', config: noKeyConfig });
  assert.strictEqual(gemini.mode, 'live');
  await assert.rejects(() => gemini.parseIntent('hello'), /GEMINI_API_KEY/);
  await assert.rejects(() => gemini.proposeOutfits({}, []), /GEMINI_API_KEY/);
  await assert.rejects(() => gemini.explainOutfit({}), /GEMINI_API_KEY/);
});

test('live request targets only the Google Generative Language API endpoint', async () => {
  const stub = stubFetch(JSON.stringify({ occasions: [] }));
  try {
    const gemini = createGemini({ mode: 'live', config: LIVE_CONFIG });
    await gemini.parseIntent('hello', {});
    assert.strictEqual(stub.calls.length, 1);
    const { url, options } = stub.calls[0];
    assert.ok(url.startsWith('https://generativelanguage.googleapis.com/'),
      'must call only the Google AI Studio endpoint');
    assert.ok(url.includes('gemini-2.5-flash'), 'default model should be gemini-2.5-flash');
    assert.ok(url.includes('key=test-key-123'), 'api key read from config, passed as query key');
    assert.strictEqual(options.method, 'POST');
    const body = JSON.parse(options.body);
    assert.ok(Array.isArray(body.contents));
    assert.strictEqual(body.generationConfig.responseMimeType, 'application/json');
  } finally {
    stub.restore();
  }
});
