'use strict';

/**
 * Virtual try-on & visual preview - F05.
 *
 * Wraps the Vertex AI image adapter. Supports an OPTIONAL shopper photo ref,
 * garment-level previews, and a composite outfit visualisation that is CLEARLY
 * LABELLED as an illustrative aid - never presented as measurement-accurate or
 * as a guarantee of fit, colour, or drape.
 *
 * The SKUs in any preview are validated against the catalogue first, so a
 * preview can never reference a product that does not exist.
 */

const COMPOSITE_LABEL =
  'Illustrative composite preview only. This visual is an approximation and is '
  + 'NOT a guarantee of fit, colour accuracy, drape, or measurements.';

/**
 * @param {object} deps
 * @param {object} deps.vertexImage vertex image adapter
 * @param {object} deps.catalogue catalogue service (validate SKUs)
 */
function createTryOn(deps = {}) {
  const vertexImage = deps.vertexImage;
  const catalogue = deps.catalogue;
  if (!vertexImage) throw new Error('tryOn requires a vertexImage adapter');
  if (!catalogue) throw new Error('tryOn requires a catalogue service');

  /** Validate SKUs against the catalogue, returning only the real ones. */
  async function validSkus(skus) {
    const out = [];
    for (const sku of Array.isArray(skus) ? skus : []) {
      const product = await catalogue.getProduct(sku);
      if (product) out.push(product.sku);
    }
    return out;
  }

  /**
   * Garment-level preview for a single SKU.
   * @param {{sku:string, userPhotoRef?:string}} input
   */
  async function previewGarment(input = {}) {
    const skus = await validSkus([input.sku]);
    if (!skus.length) {
      return { status: 'invalid_sku', sku: input.sku || null, message: 'SKU not found in catalogue.' };
    }
    const result = await vertexImage.generateTryOn({ userPhotoRef: input.userPhotoRef, skus });
    return {
      status: 'ok',
      kind: 'garment',
      skus,
      imageRef: result.imageRef,
      localRef: result.localRef || null,
      isComposite: false,
      disclaimer: result.disclaimer || COMPOSITE_LABEL,
    };
  }

  /**
   * Composite outfit preview for a set of SKUs. ALWAYS labelled illustrative.
   * @param {{skus:string[], userPhotoRef?:string}} input
   */
  async function previewOutfit(input = {}) {
    const skus = await validSkus(input.skus);
    if (skus.length === 0) {
      return { status: 'invalid_sku', skus: [], message: 'No valid catalogue SKUs supplied.' };
    }
    const result = await vertexImage.generateTryOn({ userPhotoRef: input.userPhotoRef, skus });
    return {
      status: 'ok',
      kind: 'composite',
      skus,
      imageRef: result.imageRef,
      localRef: result.localRef || null,
      isComposite: true,
      // Belt-and-braces: expose BOTH the adapter disclaimer and our composite label.
      disclaimer: result.disclaimer || COMPOSITE_LABEL,
      compositeLabel: COMPOSITE_LABEL,
      isIllustrativeAid: true,
    };
  }

  /**
   * Compare two preview requests side by side (both clearly labelled).
   */
  async function compare(a = {}, b = {}) {
    return {
      status: 'ok',
      left: await previewOutfit(a),
      right: await previewOutfit(b),
      note: COMPOSITE_LABEL,
    };
  }

  return { previewGarment, previewOutfit, compare, COMPOSITE_LABEL };
}

module.exports = { createTryOn, COMPOSITE_LABEL };
