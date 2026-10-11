'use strict';

/**
 * Catalogue service - the SOURCE OF TRUTH for retail facts.
 *
 * BOUNDARY PRINCIPLE: "Gemini generates understanding and recommendations;
 * the application validates retail facts." Everything in this module reads
 * deterministically from the seeded catalogue/collections data (via the
 * Firestore adapter). Prices, stock, size availability, colour variants, and
 * collection/new-arrival status are resolved HERE and nowhere else.
 *
 * Gemini output is never trusted for any of these facts. The outfit engine
 * calls into this module to resolve/validate every SKU a Gemini concept
 * references.
 *
 * Prices are in RM (Malaysian Ringgit).
 */

/**
 * @param {object} deps
 * @param {object} deps.firestore firestore adapter (seeded, deterministic)
 * @returns {object} catalogue service
 */
function createCatalogue(deps = {}) {
  const firestore = deps.firestore;
  if (!firestore) throw new Error('catalogue requires a firestore adapter');

  // Deterministic in-memory indexes built lazily on first use. The seeded mock
  // never changes under us, so caching keeps lookups O(1) and fully stable.
  let productIndex = null; // Map<sku, product>
  let collectionIndex = null; // Map<id, collection>

  async function ensureIndexes() {
    if (productIndex && collectionIndex) return;
    const products = await firestore.query('products');
    const collections = await firestore.query('collections');
    productIndex = new Map();
    for (const p of products) productIndex.set(String(p.sku), p);
    collectionIndex = new Map();
    for (const c of collections) collectionIndex.set(String(c.id), c);
  }

  /**
   * Resolve a product by SKU. Returns null for any unknown SKU (used to reject
   * hallucinated / invalid SKUs from Gemini concepts).
   * @param {string} sku
   * @returns {Promise<object|null>}
   */
  async function getProduct(sku) {
    await ensureIndexes();
    const found = productIndex.get(String(sku));
    return found ? clone(found) : null;
  }

  /**
   * Resolve a specific colour/size variant. Returns null if the SKU, colour,
   * or size is not a real catalogue variant.
   * @param {string} sku
   * @param {string} [colour]
   * @param {string} [size]
   * @returns {Promise<{sku:string, colour:string, size:string, stock:number, priceRm:number}|null>}
   */
  async function getVariant(sku, colour, size) {
    const product = await getProduct(sku);
    if (!product) return null;

    const resolvedColour = colour || product.colour;
    if (colour && Array.isArray(product.colours) && !product.colours.includes(colour)) {
      return null;
    }

    const variants = Array.isArray(product.variants) ? product.variants : [];
    let variant = null;
    if (size != null) {
      variant = variants.find((v) => String(v.size) === String(size)) || null;
      if (!variant) return null;
    } else {
      variant = variants.find((v) => Number(v.stock) > 0) || variants[0] || null;
    }
    if (!variant) return null;

    return {
      sku: product.sku,
      colour: resolvedColour,
      size: String(variant.size),
      stock: Number(variant.stock) || 0,
      priceRm: Number(product.priceRm),
    };
  }

  /**
   * Authoritative price lookup. Returns null for unknown SKUs so callers can
   * never fall back to an AI-supplied price.
   * @param {string} sku
   * @returns {Promise<number|null>}
   */
  async function getPrice(sku) {
    const product = await getProduct(sku);
    return product ? Number(product.priceRm) : null;
  }

  /**
   * Authoritative stock lookup for a SKU + size.
   * @param {string} sku
   * @param {string} size
   * @returns {Promise<number>} 0 when SKU/size is unknown or out of stock
   */
  async function getStock(sku, size) {
    const product = await getProduct(sku);
    if (!product) return 0;
    const variants = Array.isArray(product.variants) ? product.variants : [];
    const variant = variants.find((v) => String(v.size) === String(size));
    return variant ? Number(variant.stock) || 0 : 0;
  }

  /**
   * All sizes with stock for a SKU.
   * @param {string} sku
   * @returns {Promise<string[]>}
   */
  async function getAvailableSizes(sku) {
    const product = await getProduct(sku);
    if (!product) return [];
    return (product.variants || [])
      .filter((v) => Number(v.stock) > 0)
      .map((v) => String(v.size));
  }

  /**
   * Is this SKU in stock at all (any size)?
   * @param {string} sku
   * @returns {Promise<boolean>}
   */
  async function isInStock(sku) {
    const sizes = await getAvailableSizes(sku);
    return sizes.length > 0;
  }

  /**
   * List new-arrival products. A product is a "new arrival" when it is flagged
   * newArrival OR belongs to a collection flagged isLatest / tagged latest.
   * @param {object} [opts]
   * @param {string} [opts.collectionId] restrict to a single collection
   * @returns {Promise<object[]>}
   */
  async function listNewArrivals(opts = {}) {
    await ensureIndexes();
    const latestCollectionIds = new Set();
    for (const c of collectionIndex.values()) {
      const tags = Array.isArray(c.tags) ? c.tags : [];
      if (c.isLatest || tags.includes('latest') || tags.includes('new-arrival')) {
        latestCollectionIds.add(String(c.id));
      }
    }
    const results = [];
    for (const p of productIndex.values()) {
      const inLatest = latestCollectionIds.has(String(p.collectionId));
      if (p.newArrival === true || inLatest) {
        if (opts.collectionId && String(p.collectionId) !== String(opts.collectionId)) continue;
        results.push(clone(p));
      }
    }
    // Deterministic order: SKU ascending.
    results.sort((a, b) => String(a.sku).localeCompare(String(b.sku)));
    return results;
  }

  /**
   * Build the candidate pool handed to the stylist (Gemini). This is a
   * deterministic, catalogue-backed filter: only valid, in-stock SKUs that
   * match the intent's constraints appear. Gemini only *arranges* these.
   *
   * The candidate objects deliberately carry NO retail facts beyond what the
   * stylist needs to reason about coherence (sku, category, colour, styles,
   * name). Price/stock stay owned by the application.
   *
   * @param {object} intent parsed intent (untrusted interpretation)
   * @param {object} [profile] optional style profile
   * @returns {Promise<Array<{sku,category,colour,colours,styles,name}>>}
   */
  async function filterCandidates(intent, profile = {}) {
    await ensureIndexes();
    const safeIntent = intent || {};
    const wantsLatest = safeIntent.wantsLatestCollection === true;

    let base;
    if (wantsLatest) {
      base = await listNewArrivals();
    } else {
      base = Array.from(productIndex.values()).map(clone);
    }

    const wantColours = normaliseList(
      [].concat(safeIntent.colours || [], (profile && profile.preferredColours) || [])
    );
    const avoidColours = normaliseList((profile && profile.avoidedColours) || []);
    const wantStyles = normaliseList(
      [].concat(safeIntent.styles || [], (profile && profile.preferredStyles) || [])
    );

    const scored = [];
    for (const p of base) {
      if (!(await isInStock(p.sku))) continue; // never surface out-of-stock SKUs

      const colours = normaliseList(p.colours || [p.colour]);
      // Hard exclude avoided colours only when the product offers no alternative.
      if (avoidColours.length && colours.every((c) => avoidColours.includes(c))) {
        continue;
      }

      let score = 0;
      const styles = normaliseList(p.styles || []);
      if (wantStyles.length && styles.some((s) => wantStyles.includes(s))) score += 2;
      if (wantColours.length && colours.some((c) => wantColours.includes(c))) score += 1;

      scored.push({ product: p, score });
    }

    // Deterministic sort: higher score first, then SKU ascending for stability.
    scored.sort((a, b) => (b.score - a.score) || String(a.product.sku).localeCompare(String(b.product.sku)));

    return scored.map(({ product }) => ({
      sku: product.sku,
      category: product.category,
      colour: product.colour,
      colours: Array.isArray(product.colours) ? product.colours.slice() : [product.colour],
      styles: Array.isArray(product.styles) ? product.styles.slice() : [],
      name: product.name,
    }));
  }

  /**
   * Resolve a collection by id.
   * @param {string} id
   * @returns {Promise<object|null>}
   */
  async function getCollection(id) {
    await ensureIndexes();
    const found = collectionIndex.get(String(id));
    return found ? clone(found) : null;
  }

  return {
    getProduct,
    getVariant,
    getPrice,
    getStock,
    getAvailableSizes,
    isInStock,
    listNewArrivals,
    filterCandidates,
    getCollection,
  };
}

function normaliseList(list) {
  return Array.from(
    new Set((Array.isArray(list) ? list : []).map((x) => String(x || '').trim().toLowerCase()).filter(Boolean))
  );
}

function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

module.exports = { createCatalogue };
