'use strict';

/**
 * Exact in-store rack location & navigation - F09.
 *
 * Resolves a SKU to the retailer's MAINTAINED planogram / rack-location record
 * (store name/branch, floor/level, department/zone, aisle, rack identifier,
 * shelf/rail position) and produces an illustrative set of directions that
 * matches the F09 example format.
 *
 * HARD RULE (F09): never fabricate an exact product location or directions.
 * Locations come ONLY from the retailer-maintained planogram records (seeded
 * via the Firestore adapter). When a SKU has no planogram record, we return a
 * safe "location unavailable, offer staff assistance" response and NEVER
 * invent a rack, aisle, or directions.
 *
 * BOUNDARY PRINCIPLE: Gemini never supplies rack locations. This service reads
 * deterministic, application-owned data only.
 */

const PLANOGRAM_COLLECTION = 'planogram';
const PRODUCTS_COLLECTION = 'products';

const STAFF_ASSISTANCE_MESSAGE =
  'Precise in-store location is unavailable for this item. Please ask a store '
  + 'associate for assistance and they will help you locate it.';

/**
 * @param {object} deps
 * @param {object} deps.firestore firestore adapter (seeded planogram records)
 * @param {object} [deps.catalogue] catalogue service (to resolve product name)
 */
function createStoreNavigation(deps = {}) {
  const firestore = deps.firestore;
  if (!firestore) throw new Error('storeNavigation requires a firestore adapter');
  const catalogue = deps.catalogue || null;

  let planoIndex = null; // Map<sku, record>

  async function ensureIndex() {
    if (planoIndex) return;
    const records = await firestore.query(PLANOGRAM_COLLECTION);
    planoIndex = new Map();
    for (const r of records) planoIndex.set(String(r.sku), r);
  }

  /**
   * Compose illustrative directions text in the F09 example format. We prefer
   * the retailer-supplied directions string when present; otherwise we build
   * one STRICTLY from the retailer-maintained fields (never invented).
   * @param {object} record planogram record (trusted retailer data)
   */
  function composeDirections(record) {
    if (record.directions && String(record.directions).trim()) {
      return String(record.directions).trim();
    }
    const parts = [];
    if (record.level != null) parts.push(`From the Level ${record.level} entrance`);
    if (record.zone) parts.push(`head towards ${record.zone}`);
    if (record.aisle) parts.push(`turn into ${record.aisle}`);
    if (record.rack) parts.push(`and continue to ${record.rack}`);
    const sentence = parts.join(', ');
    if (record.shelf) return `${sentence} (${record.shelf}).`;
    return `${sentence}.`;
  }

  /**
   * Resolve a SKU to its exact rack location + illustrative directions.
   *
   * @param {string} sku
   * @returns {Promise<object>} one of:
   *   { found:true, sku, productName, location:{...}, directions, source }
   *   { found:false, sku, productName, locationAvailable:false, staffAssistance:true, message, source }
   */
  async function locate(sku) {
    await ensureIndex();
    const skuKey = String(sku || '').trim();

    let productName = null;
    if (catalogue) {
      const product = await catalogue.getProduct(skuKey);
      if (product) productName = product.name;
    }

    const record = planoIndex.get(skuKey);

    // No planogram record -> SAFE fallback. Never fabricate a location.
    if (!record) {
      return {
        found: false,
        sku: skuKey,
        productName,
        locationAvailable: false,
        staffAssistance: true,
        message: STAFF_ASSISTANCE_MESSAGE,
        source: 'planogram',
      };
    }

    const location = {
      store: record.store || null,
      storeId: record.storeId || null,
      level: record.level != null ? record.level : null,
      floor: record.level != null ? `Level ${record.level}` : null,
      zone: record.zone || null,
      zoneCode: record.zoneCode || null,
      aisle: record.aisle || null,
      rack: record.rack || null,
      position: record.shelf || null,
    };

    return {
      found: true,
      sku: skuKey,
      productName,
      exampleRef: record.exampleRef || null,
      location,
      directions: composeDirections(record),
      locationAvailable: true,
      staffAssistance: false,
      source: 'planogram',
    };
  }

  return { locate, STAFF_ASSISTANCE_MESSAGE };
}

module.exports = { createStoreNavigation, STAFF_ASSISTANCE_MESSAGE, PLANOGRAM_COLLECTION, PRODUCTS_COLLECTION };
