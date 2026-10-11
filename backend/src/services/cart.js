'use strict';

/**
 * Shopping & checkout handoff - F12.
 *
 * Shoppers can save outfits, add selected items to a cart, compare looks and
 * total costs, and choose online checkout or physical shopping. We NEVER
 * process payment: checkout hands off to the retailer's existing secure
 * checkout / POS workflow via a placeholder link. The customer stays in
 * control throughout.
 *
 * HARD RULES:
 *   - No payment processing here (hand off to the retailer).
 *   - Prices come from the deterministic catalogue (retail truth), never AI.
 *
 * Persisted via the Firestore adapter.
 */

const COLLECTION = 'carts';

/** Placeholder retailer checkout endpoint - NO payment is handled in-app. */
const RETAILER_CHECKOUT_BASE = 'https://checkout.retailer.example/scenefit';

/**
 * @param {object} deps
 * @param {object} deps.firestore firestore adapter
 * @param {object} [deps.catalogue] catalogue service (authoritative prices)
 */
function createCart(deps = {}) {
  const firestore = deps.firestore;
  if (!firestore) throw new Error('cart requires a firestore adapter');
  const catalogue = deps.catalogue || null;

  function cartKey(userId) {
    return String(userId || 'guest');
  }

  function emptyCart(userId) {
    return {
      userId: cartKey(userId),
      items: [],
      savedOutfits: [],
      updatedAt: null,
    };
  }

  async function getCart(userId) {
    const stored = await firestore.get(COLLECTION, cartKey(userId));
    return stored || emptyCart(userId);
  }

  async function save(cart) {
    cart.updatedAt = new Date().toISOString();
    await firestore.set(COLLECTION, cart.userId, cart);
    return cart;
  }

  /**
   * Resolve the authoritative unit price for a SKU. Returns null for unknown
   * SKUs so we never fabricate a price.
   */
  async function resolvePrice(sku) {
    if (!catalogue) return null;
    return catalogue.getPrice(sku);
  }

  /**
   * Add an item to the cart. Price/name are resolved from the catalogue, not
   * trusted from the caller.
   * @param {string} userId
   * @param {{sku, size, colour, quantity}} item
   */
  async function addItem(userId, item = {}) {
    const cart = await getCart(userId);
    const sku = item.sku || null;
    const quantity = Math.max(1, Number(item.quantity) || 1);

    let name = null;
    let priceRm = null;
    if (catalogue && sku) {
      const product = await catalogue.getProduct(sku);
      if (product) {
        name = product.name;
        priceRm = Number(product.priceRm);
      }
    }

    const line = {
      sku,
      name,
      size: item.size || null,
      colour: item.colour || null,
      quantity,
      priceRm, // null when the SKU is unknown (never fabricated)
    };
    cart.items = Array.isArray(cart.items) ? cart.items : [];
    cart.items.push(line);
    return save(cart);
  }

  /** Save an outfit (look) alongside the cart for later comparison. */
  async function saveOutfit(userId, outfit = {}) {
    const cart = await getCart(userId);
    cart.savedOutfits = Array.isArray(cart.savedOutfits) ? cart.savedOutfits : [];
    if (!cart.savedOutfits.some((o) => o && o.id === outfit.id)) {
      cart.savedOutfits.push({
        id: outfit.id || null,
        name: outfit.name || null,
        items: Array.isArray(outfit.items) ? outfit.items : [],
        totalPriceRm: outfit.totalPriceRm != null ? Number(outfit.totalPriceRm) : null,
      });
    }
    return save(cart);
  }

  /** Compute the cart total from authoritative prices (RM). */
  function cartTotalRm(cart) {
    return round2((cart.items || []).reduce(
      (sum, i) => sum + (Number(i.priceRm) || 0) * (Number(i.quantity) || 1),
      0
    ));
  }

  /**
   * Compare saved looks and their totals, side by side.
   * @param {string} userId
   */
  async function compareLooks(userId) {
    const cart = await getCart(userId);
    const looks = (cart.savedOutfits || []).map((o) => ({
      id: o.id,
      name: o.name,
      itemCount: Array.isArray(o.items) ? o.items.length : 0,
      totalPriceRm: o.totalPriceRm != null ? o.totalPriceRm : null,
    }));
    return {
      currency: 'RM',
      looks,
      cartTotalRm: cartTotalRm(cart),
    };
  }

  /**
   * Hand off to the retailer's checkout/POS. NO payment is processed here.
   * The customer chooses 'online' or 'physical'; we return a placeholder link
   * (online) or an in-store instruction (physical). Customer stays in control.
   *
   * @param {string} userId
   * @param {{mode:'online'|'physical', storeId?:string}} opts
   */
  async function checkoutHandoff(userId, opts = {}) {
    const cart = await getCart(userId);
    const mode = opts.mode === 'physical' ? 'physical' : 'online';
    const totalRm = cartTotalRm(cart);
    const itemCount = (cart.items || []).reduce((n, i) => n + (Number(i.quantity) || 1), 0);

    const base = {
      mode,
      paymentProcessedInApp: false,
      customerInControl: true,
      currency: 'RM',
      itemCount,
      estimatedTotalRm: totalRm,
      items: cart.items || [],
      disclaimer:
        'SCENEFIT does not process payment. Checkout is completed securely in the '
        + "retailer's own checkout/POS system. You remain in control of your purchase.",
    };

    if (mode === 'physical') {
      return {
        ...base,
        instruction:
          'Take your saved cart to the store counter or a staff associate to '
          + 'complete your purchase at the point of sale.',
        checkoutUrl: null,
      };
    }

    // Online: link to the retailer checkout placeholder (hand off only).
    const skus = (cart.items || []).map((i) => i.sku).filter(Boolean);
    const query = encodeURIComponent(skus.join(','));
    return {
      ...base,
      checkoutUrl: `${RETAILER_CHECKOUT_BASE}/checkout?items=${query}`,
      instruction: 'You will be handed off to the retailer\'s secure checkout to complete payment.',
    };
  }

  return {
    getCart,
    addItem,
    saveOutfit,
    compareLooks,
    cartTotalRm,
    checkoutHandoff,
    resolvePrice,
    RETAILER_CHECKOUT_BASE,
  };
}

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

module.exports = { createCart, RETAILER_CHECKOUT_BASE, COLLECTION };
