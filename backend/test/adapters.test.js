'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { loadConfig } = require('../src/config');
const { createAdapters, createGemini } = require('../src/adapters');
const { FORBIDDEN_RETAIL_FIELDS } = require('../src/adapters/gemini');

// Everything defaults to mock mode (offline, deterministic).
const config = loadConfig({});
const adapters = createAdapters(config);

test('config defaults every service to mock mode', () => {
  for (const [service, mode] of Object.entries(config.modes)) {
    assert.strictEqual(mode, 'mock', `${service} should default to mock`);
  }
  assert.strictEqual(config.currency, 'RM');
});

test('gemini.parseIntent parses the Port Dickson occasion utterance', async () => {
  const intent = await adapters.gemini.parseIntent(
    'I have a beach getaway in Port Dickson this weekend with dinner and walking, my budget is RM250, I like linen and neutral colours, size M'
  );
  assert.strictEqual(intent.entryPoint, 'style-my-moment');
  assert.strictEqual(intent.wantsLatestCollection, false);
  assert.ok(intent.occasions.includes('beach'));
  assert.ok(intent.occasions.includes('getaway'));
  assert.ok(intent.budget && intent.budget.amountRm === 250);
  assert.strictEqual(intent.budget.currency, 'RM');
  assert.ok(intent.sizes.includes('M'));
});

test('gemini.parseIntent parses the latest-arrivals streetwear utterance', async () => {
  const intent = await adapters.gemini.parseIntent(
    "Show me what's new, I'm into relaxed tailoring and streetwear, keep it under RM300, size L"
  );
  assert.strictEqual(intent.entryPoint, 'explore-whats-new');
  assert.strictEqual(intent.wantsLatestCollection, true);
  assert.ok(intent.styles.includes('relaxed-tailoring'));
  assert.ok(intent.styles.includes('streetwear'));
  assert.ok(intent.budget && intent.budget.amountRm === 300);
  assert.ok(intent.sizes.includes('L'));
});

test('gemini.proposeOutfits returns concepts only - NEVER price/stock/availability', async () => {
  const intent = await adapters.gemini.parseIntent('something relaxed for the weekend');
  const candidatePool = [
    { sku: 'TOP-LIN-001', category: 'top', colour: 'cream' },
    { sku: 'TOP-PIQ-003', category: 'top', colour: 'navy' },
    { sku: 'BOT-SHT-010', category: 'bottom', colour: 'khaki' },
    { sku: 'BOT-CHN-011', category: 'bottom', colour: 'beige' },
    { sku: 'FTW-SND-020', category: 'footwear', colour: 'brown' },
    { sku: 'FTW-ESP-021', category: 'footwear', colour: 'beige' },
  ];
  const concepts = await adapters.gemini.proposeOutfits(intent, candidatePool);

  assert.ok(Array.isArray(concepts) && concepts.length >= 1);

  const seen = new Set();
  const walk = (obj) => {
    if (!obj || typeof obj !== 'object') return;
    for (const [key, value] of Object.entries(obj)) {
      seen.add(key.toLowerCase());
      if (value && typeof value === 'object') walk(value);
    }
  };
  concepts.forEach(walk);

  // Boundary enforcement: no authoritative retail field may appear anywhere.
  for (const forbidden of FORBIDDEN_RETAIL_FIELDS) {
    assert.ok(
      !seen.has(forbidden.toLowerCase()),
      `gemini concept must not contain retail fact field "${forbidden}"`
    );
  }

  // Positive shape checks: concepts reference candidate SKUs via slots.
  for (const concept of concepts) {
    assert.ok(concept.conceptId);
    assert.ok(Array.isArray(concept.slots) && concept.slots.length >= 1);
    assert.strictEqual(concept.isSuggestion, true);
    for (const slot of concept.slots) {
      assert.ok(slot.role);
      assert.ok(slot.candidateSku);
      assert.ok(
        candidatePool.some((c) => c.sku === slot.candidateSku),
        'slot must reference a SKU from the candidate pool'
      );
    }
  }
});

test('gemini.explainOutfit returns a non-authoritative explanation', async () => {
  const explanation = await adapters.gemini.explainOutfit({
    conceptId: 'concept-1',
    name: 'Resort Anchor Look',
    rationale: 'Light linen tones for the coast.',
  });
  assert.strictEqual(explanation.conceptId, 'concept-1');
  assert.ok(typeof explanation.explanation === 'string' && explanation.explanation.length > 0);
});

test('vertexImage.generateTryOn returns a flagged composite preview', async () => {
  const result = await adapters.vertexImage.generateTryOn({
    userPhotoRef: 'demo/user.png',
    skus: ['TOP-LIN-001', 'BOT-SHT-010'],
  });
  assert.ok(result.imageRef);
  assert.strictEqual(result.isComposite, true);
  assert.ok(typeof result.disclaimer === 'string' && result.disclaimer.length > 0);
  assert.deepStrictEqual(result.skus, ['TOP-LIN-001', 'BOT-SHT-010']);
});

test('speechToText.transcribe returns canned transcript for a demo audio ref', async () => {
  const result = await adapters.speech.transcribe('demo/port-dickson.wav');
  assert.ok(result.transcript.toLowerCase().includes('port dickson'));
  assert.ok(result.confidence > 0 && result.confidence <= 1);
  assert.strictEqual(result.languageCode, 'en-MY');
});

test('firestore mock seeds and reads catalogue data', async () => {
  const products = await adapters.firestore.query('products');
  assert.ok(products.length >= 20, 'should seed a realistic catalogue');

  const oxford = await adapters.firestore.get('products', 'TOP-OXF-004');
  assert.ok(oxford);
  assert.strictEqual(oxford.category, 'top');
  assert.strictEqual(oxford.priceRm, 89);

  // set + get round trip
  await adapters.firestore.set('userPreferences', 'u-1', { preferredSizes: ['M'] });
  const pref = await adapters.firestore.get('userPreferences', 'u-1');
  assert.deepStrictEqual(pref.preferredSizes, ['M']);
});

test('cloudStorage mock stores objects and returns refs/signed urls', async () => {
  const put = await adapters.storage.putObject('tryon/demo.png', 'binarydata');
  assert.ok(put.gsUri.startsWith('gs://'));
  const signed = await adapters.storage.getSignedUrl('tryon/demo.png');
  assert.ok(signed.url.includes('storage.googleapis.com'));
  assert.ok(signed.expiresInSeconds > 0);
});

test('bigquery mock answers named aggregate queries from seeded events', async () => {
  const byOccasion = await adapters.bigquery.query('intent-by-occasion');
  assert.ok(Array.isArray(byOccasion) && byOccasion.length >= 1);

  const commercial = await adapters.bigquery.query('commercial-summary');
  assert.strictEqual(commercial[0].metric, 'checkout_handoffs');
  assert.ok(commercial[0].totalValueRm > 0);

  const unmet = await adapters.bigquery.query('unmet-demand');
  assert.ok(unmet.some((r) => r.key === 'budget_too_low_for_three_outfits'));

  await assert.rejects(() => adapters.bigquery.query('does-not-exist'));
});

test('firebaseAuth mock verifies demo tokens and rejects bad ones', async () => {
  const shopper = await adapters.auth.verifyToken('demo-shopper');
  assert.strictEqual(shopper.role, 'shopper');

  const associate = await adapters.auth.verifyToken('associate:u-42');
  assert.deepStrictEqual(
    { uid: associate.uid, role: associate.role },
    { uid: 'u-42', role: 'associate' }
  );

  await assert.rejects(() => adapters.auth.verifyToken('garbage-token'));
});

test('live mode adapters load without importing missing packages and throw on use', async () => {
  // Module load must not throw offline even in live mode.
  const liveGemini = createGemini({ mode: 'live', config });
  assert.strictEqual(liveGemini.mode, 'live');
  // With no GEMINI_API_KEY configured, live gemini fails fast with a clear
  // config error (distinct from a transient API failure).
  await assert.rejects(() => liveGemini.parseIntent('hello'), /GEMINI_API_KEY/i);

  const liveAll = createAdapters(loadConfig({
    GEMINI_MODE: 'live',
    VERTEX_IMAGE_MODE: 'live',
    SPEECH_MODE: 'live',
    FIRESTORE_MODE: 'live',
    STORAGE_MODE: 'live',
    BIGQUERY_MODE: 'live',
    AUTH_MODE: 'live',
  }));
  await assert.rejects(() => liveAll.vertexImage.generateTryOn({}), /not implemented/i);
  await assert.rejects(() => liveAll.speech.transcribe('x'), /not implemented/i);
  await assert.rejects(() => liveAll.firestore.get('products', 'x'), /not implemented/i);
  await assert.rejects(() => liveAll.storage.putObject('k', 'v'), /not implemented/i);
  await assert.rejects(() => liveAll.bigquery.query('intent-by-occasion'), /not implemented/i);
  await assert.rejects(() => liveAll.auth.verifyToken('demo-shopper'), /not implemented/i);
});
