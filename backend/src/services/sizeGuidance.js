'use strict';

/**
 * AI-assisted fit & size guidance - F06.
 *
 * Accepts OPTIONAL height/measurements/size preferences, compares them against
 * retailer-specific size charts (sizeCharts.json via the catalogue/firestore
 * adapter), and suggests a size WITH an explanation and an UNCERTAINTY NOTICE.
 * The shopper can always override. Alternatives (one up / one down) are offered.
 *
 * HARD RULE (F06): never claim to derive exact body measurements from a photo
 * and never guarantee fit. Every suggestion carries an uncertainty disclaimer.
 */

const UNCERTAINTY_NOTICE =
  'This is a guidance estimate, not a guarantee. We cannot derive exact body '
  + 'measurements or guarantee fit, drape, or comfort - especially from a photo. '
  + 'Please try the item on in a fitting room to confirm.';

/** Which measurement to match per category when comparing to a chart. */
const PRIMARY_MEASUREMENT = Object.freeze({
  top: 'chest',
  bottom: 'waist',
  footwear: 'footLength',
});

/**
 * @param {object} deps
 * @param {object} deps.firestore firestore adapter (seeded size charts)
 * @param {object} [deps.catalogue] catalogue service (to resolve a SKU's category)
 */
function createSizeGuidance(deps = {}) {
  const firestore = deps.firestore;
  if (!firestore) throw new Error('sizeGuidance requires a firestore adapter');
  const catalogue = deps.catalogue || null;

  let chartIndex = null; // Map<category, chart>

  async function ensureCharts() {
    if (chartIndex) return;
    const charts = await firestore.query('sizeCharts');
    chartIndex = new Map();
    for (const c of charts) chartIndex.set(String(c.category), c);
  }

  /**
   * Suggest a size for a category (or a specific SKU).
   *
   * @param {object} input
   * @param {string} [input.category] 'top' | 'bottom' | 'footwear' | 'accessory'
   * @param {string} [input.sku] resolve category from a catalogue SKU instead
   * @param {object} [input.measurements] e.g. { chest: 99, waist: 84, footLength: 26.3 }
   * @param {string} [input.preferredSize] shopper-stated preference
   * @param {string} [input.override] explicit override (wins, still with notice)
   * @param {boolean} [input.fromPhoto] whether measurements were photo-derived
   * @returns {Promise<object>}
   */
  async function suggest(input = {}) {
    await ensureCharts();

    let category = input.category || null;
    if (!category && input.sku && catalogue) {
      const product = await catalogue.getProduct(input.sku);
      if (product) category = product.category;
    }
    category = category || 'top';

    const chart = chartIndex.get(String(category));
    const notices = [UNCERTAINTY_NOTICE];
    if (input.fromPhoto) {
      notices.push(
        'Measurements inferred from a photo are approximate; we never claim exact '
        + 'body measurements from an image.'
      );
    }

    // Explicit override always wins (shopper autonomy), but still carries notice.
    if (input.override) {
      return {
        category,
        sku: input.sku || null,
        suggestedSize: String(input.override),
        source: 'override',
        rationale: `Using your chosen size ${input.override}.`,
        alternatives: neighbours(chart, String(input.override)),
        uncertaintyNotices: notices,
        confidence: 'user-specified',
        derivedExactMeasurements: false,
      };
    }

    if (!chart || !Array.isArray(chart.sizes) || !chart.sizes.length) {
      // Fall back to a stated preference; never fabricate a chart result.
      return {
        category,
        sku: input.sku || null,
        suggestedSize: input.preferredSize ? String(input.preferredSize) : null,
        source: input.preferredSize ? 'preference' : 'unavailable',
        rationale: input.preferredSize
          ? `No size chart for ${category}; using your stated preference.`
          : `No size chart available for ${category}.`,
        alternatives: [],
        uncertaintyNotices: notices,
        confidence: 'low',
        derivedExactMeasurements: false,
      };
    }

    const measurements = input.measurements || {};
    const key = PRIMARY_MEASUREMENT[category];
    const value = key != null ? Number(measurements[key]) : NaN;

    // No usable measurement -> defer to stated preference, with notice.
    if (!key || !Number.isFinite(value)) {
      const fallback = input.preferredSize ? String(input.preferredSize) : null;
      return {
        category,
        sku: input.sku || null,
        suggestedSize: fallback,
        source: fallback ? 'preference' : 'insufficient-input',
        rationale: fallback
          ? `No ${key || 'measurement'} provided; using your stated size preference ${fallback}.`
          : `Please share your ${key || 'measurements'} or a preferred size for a suggestion.`,
        alternatives: fallback ? neighbours(chart, fallback) : [],
        uncertaintyNotices: notices,
        confidence: 'low',
        derivedExactMeasurements: false,
      };
    }

    // Match the measurement against the chart ranges.
    const match = matchSize(chart, key, value);
    return {
      category,
      sku: input.sku || null,
      suggestedSize: match.size,
      source: 'size-chart',
      rationale: match.size
        ? `Based on ${key} ${value} cm, size ${match.size} is the closest fit (${match.fitNote}).`
        : `Your ${key} ${value} cm sits outside the charted range; the nearest size is ${match.nearest}.`,
      alternatives: neighbours(chart, match.size || match.nearest),
      uncertaintyNotices: notices,
      confidence: match.exact ? 'medium' : 'low',
      derivedExactMeasurements: false,
    };
  }

  return { suggest, UNCERTAINTY_NOTICE };
}

/** Find the chart size whose range contains the value; else nearest by midpoint. */
function matchSize(chart, key, value) {
  let nearest = null;
  let nearestDist = Infinity;
  for (const row of chart.sizes) {
    const range = row[key];
    if (Array.isArray(range) && range.length === 2) {
      if (value >= range[0] && value <= range[1]) {
        return { size: row.size, fitNote: row.fitNote || '', exact: true };
      }
      const mid = (range[0] + range[1]) / 2;
      const dist = Math.abs(value - mid);
      if (dist < nearestDist) { nearestDist = dist; nearest = row.size; }
    }
  }
  return { size: null, nearest, exact: false };
}

/** One size up and one size down (as alternatives). */
function neighbours(chart, size) {
  if (!chart || !Array.isArray(chart.sizes) || !size) return [];
  const order = chart.sizes.map((s) => String(s.size));
  const idx = order.indexOf(String(size));
  if (idx === -1) return [];
  const out = [];
  if (idx - 1 >= 0) out.push({ size: order[idx - 1], relation: 'smaller' });
  if (idx + 1 < order.length) out.push({ size: order[idx + 1], relation: 'larger' });
  return out;
}

module.exports = { createSizeGuidance, UNCERTAINTY_NOTICE };
