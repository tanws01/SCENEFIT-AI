'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { loadConfig } = require('../src/config');
const { createAdapters } = require('../src/adapters');
const { createCatalogue } = require('../src/services/catalogue');
const { createSizeGuidance, UNCERTAINTY_NOTICE } = require('../src/services/sizeGuidance');

function build() {
  const adapters = createAdapters(loadConfig({}));
  const catalogue = createCatalogue({ firestore: adapters.firestore });
  const sizeGuidance = createSizeGuidance({ firestore: adapters.firestore, catalogue });
  return { sizeGuidance };
}

test('size suggestion from a chest measurement always includes an uncertainty notice', async () => {
  const { sizeGuidance } = build();
  const result = await sizeGuidance.suggest({ category: 'top', measurements: { chest: 99 } });

  assert.strictEqual(result.suggestedSize, 'M'); // 97-102 cm range
  assert.ok(Array.isArray(result.uncertaintyNotices) && result.uncertaintyNotices.length >= 1);
  assert.ok(result.uncertaintyNotices.includes(UNCERTAINTY_NOTICE));
  assert.strictEqual(result.derivedExactMeasurements, false, 'never claims exact measurements');
  assert.ok(result.alternatives.length >= 1, 'offers alternative sizes');
});

test('photo-derived input adds an extra "approximate" notice and never claims exact measurements', async () => {
  const { sizeGuidance } = build();
  const result = await sizeGuidance.suggest({
    category: 'bottom',
    measurements: { waist: 84 },
    fromPhoto: true,
  });
  assert.strictEqual(result.suggestedSize, 'M'); // waist 82-87
  assert.strictEqual(result.derivedExactMeasurements, false);
  assert.ok(
    result.uncertaintyNotices.some((n) => /photo/i.test(n) && /approximate/i.test(n)),
    'photo input must carry an approximate/uncertain notice'
  );
});

test('explicit override wins but still carries an uncertainty notice', async () => {
  const { sizeGuidance } = build();
  const result = await sizeGuidance.suggest({ category: 'top', measurements: { chest: 99 }, override: 'L' });
  assert.strictEqual(result.suggestedSize, 'L');
  assert.strictEqual(result.source, 'override');
  assert.ok(result.uncertaintyNotices.includes(UNCERTAINTY_NOTICE));
});

test('resolves category from a SKU and suggests a footwear size', async () => {
  const { sizeGuidance } = build();
  const result = await sizeGuidance.suggest({ sku: 'FTW-SNK-022', measurements: { footLength: 26.3 } });
  assert.strictEqual(result.category, 'footwear');
  assert.strictEqual(result.suggestedSize, '42'); // 26.2-26.7
  assert.ok(result.uncertaintyNotices.includes(UNCERTAINTY_NOTICE));
});

test('no measurement and no preference -> asks for input, still never claims exact fit', async () => {
  const { sizeGuidance } = build();
  const result = await sizeGuidance.suggest({ category: 'top' });
  assert.strictEqual(result.suggestedSize, null);
  assert.strictEqual(result.derivedExactMeasurements, false);
  assert.ok(result.uncertaintyNotices.includes(UNCERTAINTY_NOTICE));
});
