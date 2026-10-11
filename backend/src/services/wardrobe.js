'use strict';

/**
 * Existing wardrobe integration - F08.
 *
 * Shoppers can add items they already own (manually or by photo ref) and mark
 * them owned. The engine can then build looks AROUND those owned items and show
 * the incremental PURCHASE COST separately from the full outfit composition, so
 * duplicate purchases are reduced.
 *
 * Owned items may reference a real catalogue SKU (so we can resolve exact
 * price/size) or be free-form ("my white sneakers"). Free-form items carry no
 * retail facts and contribute zero to purchase cost but still count toward the
 * composition.
 *
 * Persisted via the Firestore adapter.
 */

const COLLECTION = 'wardrobes';

/**
 * @param {object} deps
 * @param {object} deps.firestore firestore adapter
 * @param {object} [deps.catalogue] catalogue service (to resolve SKU-backed items)
 */
function createWardrobe(deps = {}) {
  const firestore = deps.firestore;
  if (!firestore) throw new Error('wardrobe requires a firestore adapter');
  const catalogue = deps.catalogue || null;

  async function list(userId) {
    const stored = await firestore.get(COLLECTION, userId);
    return stored && Array.isArray(stored.items) ? stored.items : [];
  }

  /**
   * Add an owned wardrobe item.
   * @param {string} userId
   * @param {{sku?:string, label?:string, category?:string, colour?:string, photoRef?:string}} item
   */
  async function addItem(userId, item = {}) {
    const items = await list(userId);
    let resolved = {
      id: item.sku || `wardrobe-${items.length + 1}`,
      sku: item.sku || null,
      label: item.label || null,
      category: item.category || null,
      colour: item.colour || null,
      photoRef: item.photoRef || null,
      owned: true,
    };
    // If the item references a real SKU, enrich from the catalogue (truth).
    if (resolved.sku && catalogue) {
      const product = await catalogue.getProduct(resolved.sku);
      if (product) {
        resolved = {
          ...resolved,
          label: resolved.label || product.name,
          category: product.category,
          colour: resolved.colour || product.colour,
        };
      }
    }
    const next = items.filter((i) => i.id !== resolved.id).concat([resolved]);
    await firestore.set(COLLECTION, userId, { userId, items: next });
    return resolved;
  }

  async function removeItem(userId, id) {
    const items = await list(userId);
    const next = items.filter((i) => i.id !== id);
    await firestore.set(COLLECTION, userId, { userId, items: next });
    return next;
  }

  /**
   * Given a presented outfit (from the outfit engine) and the shopper's owned
   * items, split the composition into {toBuy, alreadyOwned} and compute the
   * incremental purchase cost (owned items contribute RM0).
   *
   * @param {string} userId
   * @param {{items:Array<{sku,role,name,priceRm}>, totalPriceRm:number}} outfit
   */
  async function applyOwnership(userId, outfit) {
    const owned = await list(userId);
    const ownedSkus = new Set(owned.filter((o) => o.sku).map((o) => o.sku));
    const ownedCategories = new Set(owned.filter((o) => !o.sku && o.category).map((o) => o.category));

    const toBuy = [];
    const alreadyOwned = [];
    for (const item of outfit.items || []) {
      const isOwned = ownedSkus.has(item.sku) || ownedCategories.has(item.category);
      if (isOwned) alreadyOwned.push({ ...item, owned: true });
      else toBuy.push(item);
    }
    const purchaseCostRm = round2(toBuy.reduce((acc, i) => acc + Number(i.priceRm || 0), 0));
    return {
      composition: outfit.items || [],
      fullOutfitCostRm: outfit.totalPriceRm != null ? outfit.totalPriceRm : round2((outfit.items || []).reduce((a, i) => a + Number(i.priceRm || 0), 0)),
      alreadyOwned,
      toBuy,
      purchaseCostRm,
      savingsRm: round2(((outfit.totalPriceRm) || 0) - purchaseCostRm),
    };
  }

  return { list, addItem, removeItem, applyOwnership };
}

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

module.exports = { createWardrobe };
