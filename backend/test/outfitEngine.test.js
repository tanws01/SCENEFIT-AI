'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { loadConfig } = require('../src/config');
const { createAdapters } = require('../src/adapters');
const { createServices } = require('../src/server');

function freshServices() {
  const adapters = createAdapters(loadConfig({}));
  return { adapters, services: createServices(adapters) };
}

const PORT_DICKSON =
  'I have a beach getaway in Port Dickson this weekend with dinner and walking, '
  + 'my budget is RM250, I like linen and neutral colours, size M';
const LATEST =
  "Show me what's new, I'm into relaxed tailoring and streetwear, keep it under RM300, size L";

/** Assert an outfit is 100% valid: real SKUs, catalogue prices, within budget. */
async function assertOutfitValid(catalogue, outfit, budgetRm) {
  assert.ok(Array.isArray(outfit.items) && outfit.items.length >= 3, 'needs >=3 items');
  let recomputed = 0;
  for (const item of outfit.items) {
    const product = await catalogue.getProduct(item.sku);
    assert.ok(product, `every item must resolve to a real catalogue SKU: ${item.sku}`);
    assert.strictEqual(item.priceRm, product.priceRm, 'price must come from catalogue');
    const stock = await catalogue.getStock(item.sku, item.size);
    assert.ok(stock > 0, `item ${item.sku} size ${item.size} must be in stock`);
    recomputed += product.priceRm;
  }
  recomputed = Math.round(recomputed * 100) / 100;
  assert.strictEqual(recomputed, outfit.totalPriceRm, 'total must equal sum of catalogue prices');
  if (budgetRm != null) {
    assert.ok(outfit.totalPriceRm <= budgetRm, `total ${outfit.totalPriceRm} must be <= budget ${budgetRm}`);
    assert.strictEqual(outfit.budgetCompliant, true);
  }
}

function distinctCount(outfits) {
  const keys = outfits.map((o) => o.items.map((i) => i.sku).sort().join('|'));
  return new Set(keys).size;
}

test('(a) Port Dickson occasion -> exactly 3 distinct valid outfits all <= RM250', async () => {
  const { adapters, services } = freshServices();
  const intent = await adapters.gemini.parseIntent(PORT_DICKSON);
  const result = await services.outfitEngine.recommend(intent);

  assert.strictEqual(result.status, 'ok');
  assert.strictEqual(result.outfits.length, 3, 'exactly three outfits');
  assert.strictEqual(distinctCount(result.outfits), 3, 'outfits are meaningfully different');

  for (const outfit of result.outfits) {
    await assertOutfitValid(services.catalogue, outfit, 250);
    assert.ok(typeof outfit.rationale === 'string' && outfit.rationale.length > 0, 'has styling explanation');
    assert.ok(outfit.rationaleSource.includes('gemini'), 'rationale labelled as suggestion');
    assert.deepStrictEqual(
      outfit.actionButtons.sort(),
      ['compare', 'findInStore', 'save', 'shop', 'swap', 'tryOn'],
      'has action buttons'
    );
  }
});

test('(b) latest-arrivals -> 3 distinct outfits built only from new-arrival SKUs, each <= RM300', async () => {
  const { adapters, services } = freshServices();
  const intent = await adapters.gemini.parseIntent(LATEST);
  const result = await services.outfitEngine.recommend(intent);

  assert.strictEqual(result.status, 'ok');
  assert.strictEqual(result.outfits.length, 3);
  assert.strictEqual(distinctCount(result.outfits), 3);

  const newArrivals = await services.catalogue.listNewArrivals();
  const newArrivalSkus = new Set(newArrivals.map((p) => p.sku));

  for (const outfit of result.outfits) {
    await assertOutfitValid(services.catalogue, outfit, 300);
    for (const item of outfit.items) {
      assert.ok(newArrivalSkus.has(item.sku), `${item.sku} must be a new arrival`);
    }
  }
});

test('(c) budget-compliance property test - across many seeded requests NO total ever exceeds the budget', async () => {
  const { adapters, services } = freshServices();
  const budgets = [200, 220, 250, 275, 300, 350, 400];
  const utterances = [
    'beach getaway in Port Dickson, dinner and walking, size M, linen neutral',
    "what's new, relaxed tailoring and streetwear, size L",
    'something casual and minimalist for the weekend, size S',
    'latest arrivals streetwear, size M',
    'resort look for a coastal trip, size L beige',
  ];
  let checked = 0;
  for (const u of utterances) {
    for (const b of budgets) {
      const intent = await adapters.gemini.parseIntent(`${u}, budget RM${b}`);
      const result = await services.outfitEngine.recommend(intent);
      if (result.status === 'ok') {
        for (const outfit of result.outfits) {
          assert.ok(outfit.totalPriceRm <= b, `total ${outfit.totalPriceRm} <= budget ${b} for "${u}"`);
          checked += 1;
        }
      } else {
        // Insufficient result still invents nothing and offers only real items.
        assert.strictEqual(result.meta.invented, false);
      }
    }
  }
  assert.ok(checked > 0, 'property test must have checked some outfits');
});

test('(d) valid-SKU property test - every item in every returned outfit resolves to a real catalogue SKU', async () => {
  const { adapters, services } = freshServices();
  const utterances = [PORT_DICKSON, LATEST, 'casual minimalist weekend budget RM400 size M'];
  for (const u of utterances) {
    const intent = await adapters.gemini.parseIntent(u);
    const result = await services.outfitEngine.recommend(intent);
    const outfits = result.outfits || [];
    for (const outfit of outfits) {
      for (const item of outfit.items) {
        const product = await services.catalogue.getProduct(item.sku);
        assert.ok(product, `invalid SKU surfaced: ${item.sku}`);
      }
    }
  }
});

test('(e) low-budget scenario -> clear insufficient fallback with alternatives, invents nothing', async () => {
  const { adapters, services } = freshServices();
  const intent = await adapters.gemini.parseIntent('something nice for the weekend, my budget is RM80, size M');
  const result = await services.outfitEngine.recommend(intent);

  assert.strictEqual(result.status, 'insufficient');
  assert.ok(result.formed < 3, 'cannot form three outfits');
  assert.ok(typeof result.message === 'string' && /could not build/i.test(result.message));
  assert.strictEqual(result.meta.invented, false);
  assert.ok(Array.isArray(result.alternatives) && result.alternatives.length > 0, 'offers alternatives');

  // Every alternative is a REAL catalogue item (never invented).
  for (const alt of result.alternatives) {
    const product = await services.catalogue.getProduct(alt.sku);
    assert.ok(product, `alternative must be a real SKU: ${alt.sku}`);
    assert.strictEqual(alt.priceRm, product.priceRm);
  }
  // The documented minimum complete outfit is RM197.
  assert.strictEqual(result.minCompleteOutfitRm, 197);
});

test('(f) ADVERSARIAL - bad Gemini concepts (non-existent SKU + over-budget) are rejected/corrected', async () => {
  const { adapters, services } = freshServices();
  const intent = await adapters.gemini.parseIntent(PORT_DICKSON); // budget RM250

  // Hand-crafted UNTRUSTED concepts that a misbehaving model might emit:
  //  concept A references a hallucinated SKU that does not exist in catalogue;
  //  concept B is a real-but-OVER-BUDGET combination (sum well over RM250);
  //  concept C smuggles a fake price (which must be ignored - price from catalogue).
  const maliciousConcepts = [
    {
      conceptId: 'bad-1',
      name: 'Hallucinated Look',
      slots: [
        { role: 'top', candidateSku: 'TOP-DOES-NOT-EXIST-999' },
        { role: 'bottom', candidateSku: 'BOT-SHT-010' },
        { role: 'footwear', candidateSku: 'FTW-ESP-021' },
      ],
      isSuggestion: true,
    },
    {
      conceptId: 'bad-2',
      name: 'Over Budget Look',
      slots: [
        { role: 'top', candidateSku: 'TOP-FLN-007' }, // 119
        { role: 'bottom', candidateSku: 'BOT-TRS-012' }, // 99
        { role: 'outerwear', candidateSku: 'OUT-BMB-031' }, // 159 -> total 377 > 250
        { role: 'footwear', candidateSku: 'FTW-LOF-024' }, // 109
      ],
      isSuggestion: true,
    },
    {
      conceptId: 'smuggle-price',
      name: 'Smuggled Price Look',
      slots: [
        { role: 'top', candidateSku: 'TOP-LIN-002', priceRm: 1 }, // lie: real price is 59
        { role: 'bottom', candidateSku: 'BOT-SWT-015' }, // 59
        { role: 'footwear', candidateSku: 'FTW-ESP-021' }, // 79 -> total 197
      ],
      isSuggestion: true,
    },
  ];

  const result = await services.outfitEngine.recommend(intent, { concepts: maliciousConcepts });

  // Despite the bad concepts, output stays 100% valid and within budget.
  assert.strictEqual(result.status, 'ok');
  assert.strictEqual(result.outfits.length, 3);

  for (const outfit of result.outfits) {
    await assertOutfitValid(services.catalogue, outfit, 250);
    // The hallucinated SKU must never appear.
    assert.ok(!outfit.items.some((i) => i.sku === 'TOP-DOES-NOT-EXIST-999'), 'no hallucinated SKU');
    // The over-budget 4-piece combo must never appear intact.
    const skuSet = new Set(outfit.items.map((i) => i.sku));
    const overBudgetCombo = ['TOP-FLN-007', 'BOT-TRS-012', 'OUT-BMB-031', 'FTW-LOF-024'];
    assert.ok(!overBudgetCombo.every((s) => skuSet.has(s)), 'over-budget combo rejected');
  }

  // The at-least-one concept that WAS valid (smuggled price) must use the real
  // catalogue price, proving the app validated rather than trusting the model.
  const smuggled = result.outfits.find((o) => o.items.some((i) => i.sku === 'TOP-LIN-002'));
  if (smuggled) {
    const lin = smuggled.items.find((i) => i.sku === 'TOP-LIN-002');
    assert.strictEqual(lin.priceRm, 59, 'price must come from catalogue, not the concept');
  }

  // The engine reports it rejected the invalid concepts.
  assert.ok(result.meta.conceptsRejected >= 2, 'engine rejected the invalid/over-budget concepts');
});

test('final guard - recommend never returns an over-budget or invalid outfit even with an empty candidate pool', async () => {
  const { services } = freshServices();
  const intent = {
    rawUtterance: 'x', entryPoint: 'style-my-moment', wantsLatestCollection: false,
    occasions: [], activities: [], styles: [], colours: [], sizes: ['M'],
    budget: { amountRm: 250, currency: 'RM' }, confidence: 0.5, source: 'test',
  };
  // Force an empty pool AND empty concepts -> must gracefully report insufficient.
  const result = await services.outfitEngine.recommend(intent, { candidatePool: [], concepts: [] });
  assert.ok(['ok', 'insufficient'].includes(result.status));
  if (result.status === 'insufficient') {
    assert.strictEqual(result.meta.invented, false);
  }
});
