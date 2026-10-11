'use strict';

/**
 * Tests for the LIVE AI-driven retailer-insights layer (Task #2).
 *
 * The deterministic BigQuery aggregates remain the SOURCE OF TRUTH. The gemini
 * adapter only ADDS a non-guaranteed, decision-support analysis block
 * (narrative / predictions / suggestions) alongside those numbers. These tests
 * assert the AI block is present and labelled, that it NEVER overrides the
 * aggregated numbers, that smuggled retail facts are stripped, and that a
 * simulated live failure falls back to the deterministic mock analysis.
 *
 * Live-path tests stub globalThis.fetch (Node 22, no deps), mirroring the
 * existing geminiLive tests.
 */

const { test } = require('node:test');
const assert = require('node:assert');

const { loadConfig } = require('../src/config');
const { createAdapters } = require('../src/adapters');
const { createGemini } = require('../src/adapters/gemini');
const { createAnalytics } = require('../src/services/analytics');

const STORE = require('../data/store.json');
const LIVE_CONFIG = loadConfig({ GEMINI_MODE: 'live', GEMINI_API_KEY: 'test-key-123' });

/** Install a Generative Language API shaped fake fetch returning `modelText`. */
function stubFetch(modelText, { ok = true, status = 200, throwTransport = false } = {}) {
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    if (throwTransport) throw new Error('simulated network failure');
    const text = typeof modelText === 'function' ? modelText() : modelText;
    return { ok, status, async json() { return { candidates: [{ content: { parts: [{ text }] } }] }; } };
  };
  return { restore: () => { globalThis.fetch = original; } };
}

/** Build an analytics service with the given gemini adapter wired in. */
function buildAnalytics(gemini) {
  const adapters = createAdapters(loadConfig({}));
  return {
    analytics: createAnalytics({ bigquery: adapters.bigquery, store: STORE, gemini }),
    bigquery: adapters.bigquery,
  };
}

test('mock analytics: no gemini wired -> dashboard still returns, AI block omitted', async () => {
  const { analytics } = buildAnalytics(null);
  const dash = await analytics.retailDashboard();
  assert.strictEqual(dash.dashboard, 'retail-intelligence');
  assert.ok(dash.sections.shoppingIntent.popularOccasions.length >= 1);
  assert.strictEqual('aiInsights' in dash, false, 'no AI block without a gemini adapter');
});

test('mock gemini: AI insights present with non-guaranteed/decision-support labelling', async () => {
  const gemini = createGemini({ mode: 'mock' });
  const { analytics } = buildAnalytics(gemini);
  const dash = await analytics.retailDashboard();

  assert.ok(dash.aiInsights, 'aiInsights block present');
  const ai = dash.aiInsights;
  assert.strictEqual(ai.aiGenerated, true);
  assert.strictEqual(ai.interpretation, 'decision-support');
  assert.strictEqual(ai.guaranteedForecast, false);
  assert.strictEqual(ai.autoReorder, false);
  assert.strictEqual(ai.source, 'gemini-mock');
  assert.ok(typeof ai.narrative === 'string' && ai.narrative.length > 0);
  assert.ok(Array.isArray(ai.predictions));
  assert.ok(Array.isArray(ai.suggestions));
  // Every prediction is explicitly a non-guaranteed forecast.
  for (const p of ai.predictions) assert.strictEqual(p.guaranteedForecast, false);
});

test('merchandisingInsights also carries the AI analysis block', async () => {
  const gemini = createGemini({ mode: 'mock' });
  const { analytics } = buildAnalytics(gemini);
  const merch = await analytics.merchandisingInsights();
  assert.ok(merch.aiAnalysis, 'aiAnalysis block present');
  assert.strictEqual(merch.aiAnalysis.aiGenerated, true);
  assert.strictEqual(merch.aiAnalysis.guaranteedForecast, false);
  // Deterministic insight buckets are untouched.
  for (const key of Object.keys(merch.insights)) {
    assert.strictEqual(merch.insights[key].interpretation, 'decision-support');
  }
});

test('AI analysis NEVER overrides the deterministic aggregated numbers', async () => {
  // A hostile stubbed model tries to restate different numbers; the dashboard
  // numbers must still equal the raw BigQuery aggregates.
  const stub = stubFetch(JSON.stringify({
    narrative: 'totally different story',
    predictions: [{ label: 'made up', basis: 'nonsense' }],
    suggestions: ['do a random thing'],
    // Attempt to smuggle fabricated numbers / facts:
    byOccasion: [{ key: 'FAKE', count: 9999 }],
    popularOccasions: [{ key: 'FAKE', count: 9999 }],
    price: 123, stock: 5,
  }));
  try {
    const gemini = createGemini({ mode: 'live', config: LIVE_CONFIG });
    const { analytics, bigquery } = buildAnalytics(gemini);
    const dash = await analytics.retailDashboard();

    const truth = await bigquery.query('intent-by-occasion');
    assert.deepStrictEqual(dash.sections.shoppingIntent.popularOccasions, truth,
      'section numbers must equal the BigQuery aggregates, not the model output');
    // The model text is confined to the AI block.
    assert.strictEqual(dash.aiInsights.source, 'gemini-live');
    assert.strictEqual(dash.aiInsights.narrative, 'totally different story');
  } finally {
    stub.restore();
  }
});

test('stripRetailFields removes any price/stock/SKU the model injects into insights', async () => {
  const stub = stubFetch(JSON.stringify({
    narrative: 'ok',
    predictions: [{ label: 'demand up', basis: 'signal', price: 500, stock: 3, sku: 'TOP-LIN-001' }],
    suggestions: ['restock linen'],
    price: 999, availability: 'in-stock', rackLocation: 'A3',
  }));
  try {
    const gemini = createGemini({ mode: 'live', config: LIVE_CONFIG });
    const { analytics } = buildAnalytics(gemini);
    const dash = await analytics.retailDashboard();

    const seen = new Set();
    const walk = (o) => {
      if (!o || typeof o !== 'object') return;
      for (const [k, v] of Object.entries(o)) { seen.add(k.toLowerCase()); walk(v); }
    };
    walk(dash.aiInsights);
    for (const forbidden of ['price', 'stock', 'availability', 'racklocation', 'sku']) {
      assert.ok(!seen.has(forbidden), `retail field "${forbidden}" must be stripped from AI insights`);
    }
  } finally {
    stub.restore();
  }
});

test('live analysis falls back to the deterministic mock analysis on failure', async () => {
  const stub = stubFetch('irrelevant', { ok: false, status: 503 });
  try {
    const gemini = createGemini({ mode: 'live', config: LIVE_CONFIG });
    const { analytics } = buildAnalytics(gemini);
    const dash = await analytics.retailDashboard();
    assert.ok(dash.aiInsights, 'AI block present even after live failure');
    assert.strictEqual(dash.aiInsights.source, 'gemini-mock', 'fell back to deterministic mock analysis');
    assert.strictEqual(dash.aiInsights.aiGenerated, true);
  } finally {
    stub.restore();
  }
});

test('live analysis falls back to mock on transport error (no throw)', async () => {
  const stub = stubFetch(null, { throwTransport: true });
  try {
    const gemini = createGemini({ mode: 'live', config: LIVE_CONFIG });
    const { analytics } = buildAnalytics(gemini);
    const merch = await analytics.merchandisingInsights();
    assert.strictEqual(merch.aiAnalysis.source, 'gemini-mock');
  } finally {
    stub.restore();
  }
});
