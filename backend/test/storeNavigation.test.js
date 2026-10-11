'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { loadConfig } = require('../src/config');
const { createAdapters } = require('../src/adapters');
const { createCatalogue } = require('../src/services/catalogue');
const { createStoreNavigation, STAFF_ASSISTANCE_MESSAGE } = require('../src/services/storeNavigation');

function build() {
  const adapters = createAdapters(loadConfig({}));
  const catalogue = createCatalogue({ firestore: adapters.firestore });
  const nav = createStoreNavigation({ firestore: adapters.firestore, catalogue });
  return { nav };
}

test('known SKU (F09 example) returns full planogram location + illustrative directions', async () => {
  const { nav } = build();
  const result = await nav.locate('TOP-OXF-004');

  assert.strictEqual(result.found, true);
  assert.strictEqual(result.locationAvailable, true);
  assert.strictEqual(result.staffAssistance, false);

  const loc = result.location;
  assert.strictEqual(loc.store, 'Demo Flagship Level 2');
  assert.strictEqual(loc.floor, 'Level 2');
  assert.strictEqual(loc.zone, 'Zone B New Arrivals');
  assert.strictEqual(loc.aisle, 'Aisle 04');
  assert.strictEqual(loc.rack, 'Rack B-17');
  assert.strictEqual(loc.position, 'Upper Rail');

  assert.ok(typeof result.directions === 'string' && result.directions.length > 0);
  assert.match(result.directions, /B-17/);
});

test('another known SKU resolves its own distinct rack from the planogram', async () => {
  const { nav } = build();
  const result = await nav.locate('FTW-CNV-025');
  assert.strictEqual(result.found, true);
  assert.strictEqual(result.location.zone, 'Zone C Footwear & Accessories');
  assert.strictEqual(result.location.rack, 'Rack C-06');
});

test('unknown SKU returns the staff-assistance fallback and NEVER fabricates a rack', async () => {
  const { nav } = build();
  const result = await nav.locate('TOP-DOES-NOT-EXIST-999');

  assert.strictEqual(result.found, false);
  assert.strictEqual(result.locationAvailable, false);
  assert.strictEqual(result.staffAssistance, true);
  assert.strictEqual(result.message, STAFF_ASSISTANCE_MESSAGE);

  // No fabricated location fields of any kind.
  assert.strictEqual(result.location, undefined);
  assert.ok(!('rack' in result), 'must not invent a rack');
  assert.ok(!('aisle' in result), 'must not invent an aisle');
  assert.ok(!('directions' in result), 'must not invent directions');
});

test('a REAL catalogue product with NO planogram entry falls back safely (resolves name, no location)', async () => {
  const { nav } = build();
  // ACC-SCF-045 is a genuine catalogue SKU (products.json) that deliberately
  // has NO planogram record, so this exercises the "known product, missing
  // planogram" branch - distinct from the unknown-SKU case above.
  const result = await nav.locate('ACC-SCF-045');

  assert.strictEqual(result.found, false);
  assert.strictEqual(result.locationAvailable, false);
  assert.strictEqual(result.staffAssistance, true);
  assert.strictEqual(result.message, STAFF_ASSISTANCE_MESSAGE);

  // The product name IS resolved from the catalogue (it is a real SKU)...
  assert.strictEqual(result.productName, 'Lightweight Woven Scarf');

  // ...but NO location is ever fabricated for a product without a planogram.
  assert.strictEqual(result.location, undefined);
  assert.ok(!('rack' in result), 'must not invent a rack');
  assert.ok(!('aisle' in result), 'must not invent an aisle');
  assert.ok(!('directions' in result), 'must not invent directions');
});
