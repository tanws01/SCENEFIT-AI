'use strict';

/**
 * Retail intelligence & merchandising analytics - F13 / F14 / F15.
 *
 * Emits PRIVACY-PROTECTED analytics events (no PII; aggregate-ready only) via
 * the BigQuery adapter and provides aggregate dashboard queries:
 *
 *   F13 Retail Intelligence Dashboard:
 *     1 Shopping Intent, 2 Product Demand, 3 Unmet Demand,
 *     4 In-Store Experience, 5 Commercial Performance.
 *   F14 Staff Operations Dashboard: incoming picking requests, SKU/size/colour
 *     + rack location, fitting-room availability, queue tickets.
 *   F15 Merchandising & Inventory Insights: human-decision-support signals.
 *
 * HARD RULES:
 *   - Events MUST NOT carry PII. We strip any PII-shaped fields before emit and
 *     always stamp privacy:{pii:false, aggregationReady:true}.
 *   - F15 merchandising insights are HUMAN-DECISION-SUPPORT ONLY. They are NOT
 *     guaranteed forecasts and NOT automatic instructions to reorder stock.
 *   - All retail facts come from deterministic sources, never AI.
 *
 * BigQuery lives behind the adapter, which answers deterministic named queries
 * from seeded offline sample data.
 */

const EVENTS_TABLE = 'analytics_events';

/** Fields we refuse to persist (PII-shaped). Stripped before every emit. */
const PII_FIELDS = Object.freeze([
  'name', 'firstName', 'lastName', 'fullName', 'email', 'phone', 'phoneNumber',
  'address', 'street', 'postcode', 'postalCode', 'dob', 'dateOfBirth',
  'ip', 'ipAddress', 'deviceId', 'userId', 'customerId', 'faceId', 'photo',
  'photoRef', 'userPhotoRef', 'nric', 'passport', 'creditCard', 'card',
]);

/** Label asserting insights are decision-support, not instructions. */
const DECISION_SUPPORT_LABEL = Object.freeze({
  decisionSupport: true,
  guaranteedForecast: false,
  autoReorder: false,
  note:
    'These insights support HUMAN merchandising decisions. They are NOT '
    + 'guaranteed forecasts and NOT automatic instructions to reorder stock.',
});

/**
 * @param {object} deps
 * @param {object} deps.bigquery bigquery adapter
 * @param {object} [deps.staffTasks] staff tasks service (F14 operations data)
 * @param {object} [deps.store] seeded store record (F14 fitting-room availability)
 * @param {object} [deps.gemini] gemini adapter (AI analysis layer; optional)
 * @param {() => string} [deps.now]
 * @param {() => string} [deps.idgen]
 */
function createAnalytics(deps = {}) {
  const bigquery = deps.bigquery;
  if (!bigquery) throw new Error('analytics requires a bigquery adapter');
  const staffTasks = deps.staffTasks || null;
  const store = deps.store || null;
  // Optional AI layer. When absent the dashboards still return the full
  // deterministic aggregates (the AI block is simply omitted).
  const gemini = deps.gemini || null;
  const now = typeof deps.now === 'function' ? deps.now : () => new Date().toISOString();
  let seq = 0;
  const idgen = typeof deps.idgen === 'function'
    ? deps.idgen
    : () => `evt-live-${(++seq).toString().padStart(4, '0')}`;

  /**
   * Strip any PII-shaped fields and stamp privacy metadata. Returns an
   * aggregate-ready, privacy-protected event.
   * @param {object} raw
   */
  function sanitize(raw = {}) {
    const clean = {};
    for (const [key, value] of Object.entries(raw)) {
      if (PII_FIELDS.includes(key)) continue; // never persist PII
      clean[key] = value;
    }
    // Keep an anonymised, non-identifying bucket id only if explicitly provided.
    if (raw.anonUserId) clean.anonUserId = String(raw.anonUserId);
    clean.privacy = { pii: false, aggregationReady: true };
    return clean;
  }

  /**
   * Emit a privacy-protected analytics event to BigQuery (via the adapter).
   * @param {object} event { type, ...dimensions }
   */
  async function emit(event = {}) {
    const sanitized = {
      id: event.id || idgen(),
      type: event.type || 'intent',
      timestamp: event.timestamp || now(),
      ...sanitize(event),
    };
    // Ensure id/type/timestamp survive sanitation ordering.
    sanitized.id = event.id || sanitized.id || idgen();
    sanitized.type = event.type || sanitized.type || 'intent';
    sanitized.timestamp = event.timestamp || sanitized.timestamp || now();
    await bigquery.insertRows(EVENTS_TABLE, [sanitized]);
    return sanitized;
  }

  // ---- F13 dashboard sections (aggregate, privacy-protected) ----

  async function shoppingIntent() {
    const byOccasion = await bigquery.query('intent-by-occasion');
    return {
      title: 'Shopping Intent',
      occasionVsLatestCollection: byOccasion,
      popularOccasions: byOccasion,
      source: 'bigquery-aggregate',
    };
  }

  async function productDemand() {
    const byStyle = await bigquery.query('demand-by-style');
    return {
      title: 'Product Demand',
      mostRequestedStyles: byStyle,
      popularStylePreferences: byStyle,
      source: 'bigquery-aggregate',
    };
  }

  async function unmetDemand() {
    const unmet = await bigquery.query('unmet-demand');
    return {
      title: 'Unmet Demand',
      reasons: unmet,
      requestedButUnavailableSizes: unmet.filter((r) => /size/.test(String(r.key))),
      source: 'bigquery-aggregate',
    };
  }

  async function inStoreExperience() {
    const byZone = await bigquery.query('in-store-by-zone');
    return {
      title: 'In-Store Experience',
      activityByZone: byZone,
      locationLookupVolume: byZone,
      source: 'bigquery-aggregate',
    };
  }

  async function commercialPerformance() {
    const summary = await bigquery.query('commercial-summary');
    return {
      title: 'Commercial Performance',
      checkoutHandoffs: summary,
      source: 'bigquery-aggregate',
    };
  }

  /**
   * Gather the deterministic aggregate rows (the SOURCE OF TRUTH) once, so both
   * the dashboard sections and the AI analysis layer read the SAME numbers.
   * @returns {Promise<{byOccasion,byStyle,unmet,byZone,commercial}>}
   */
  async function gatherAggregates() {
    const [byOccasion, byStyle, unmet, byZone, commercial] = await Promise.all([
      bigquery.query('intent-by-occasion'),
      bigquery.query('demand-by-style'),
      bigquery.query('unmet-demand'),
      bigquery.query('in-store-by-zone'),
      bigquery.query('commercial-summary'),
    ]);
    return { byOccasion, byStyle, unmet, byZone, commercial };
  }

  /**
   * Build the AI analysis block from the deterministic aggregates. This ADDS
   * model-generated narrative / predictions / suggestions ALONGSIDE the hard
   * numbers; it NEVER overrides them. When no gemini adapter is wired, returns
   * null so callers can omit the block entirely.
   *
   * The gemini adapter is UNTRUSTED: its output is narrative/prediction/
   * suggestion text only and is stamped non-guaranteed / decision-support.
   * The numbers in the dashboard always come from gatherAggregates(), never
   * from the model. On any failure the live adapter itself falls back to a
   * deterministic mock analysis, so this never throws for a wired adapter.
   *
   * @param {object} aggregates result of gatherAggregates()
   */
  async function aiAnalysis(aggregates) {
    if (!gemini || typeof gemini.analyzeRetail !== 'function') return null;
    const analysis = await gemini.analyzeRetail(aggregates);
    // Belt-and-braces: the AI block carries NO authoritative numbers. We attach
    // the explicit decision-support label so the boundary is observable even if
    // a future adapter forgets to stamp it.
    return {
      ...DECISION_SUPPORT_LABEL,
      ...analysis,
      aiGenerated: true,
      interpretation: 'decision-support',
      guaranteedForecast: false,
      autoReorder: false,
    };
  }

  /**
   * F13 Retail Intelligence Dashboard - all five sections, aggregated and
   * privacy-protected. Adds an AI analysis/predictions block ALONGSIDE (never
   * overriding) the deterministic numbers when a gemini adapter is wired.
   */
  async function retailDashboard() {
    const aggregates = await gatherAggregates();
    const [intent, demand, unmet, inStore, commercial, insights] = await Promise.all([
      shoppingIntent(),
      productDemand(),
      unmetDemand(),
      inStoreExperience(),
      commercialPerformance(),
      aiAnalysis(aggregates),
    ]);
    const dashboard = {
      dashboard: 'retail-intelligence',
      privacy: { pii: false, aggregationReady: true, note: 'Aggregated, privacy-protected data with retention/access controls.' },
      sections: {
        shoppingIntent: intent,
        productDemand: demand,
        unmetDemand: unmet,
        inStoreExperience: inStore,
        commercialPerformance: commercial,
      },
    };
    // AI analysis is ADDITIVE: present only when an adapter is wired, and it
    // never replaces any of the deterministic section numbers above.
    if (insights) dashboard.aiInsights = insights;
    return dashboard;
  }

  /**
   * F14 Staff Operations Dashboard - incoming picking requests with
   * SKU/size/colour + rack location, plus fitting-room availability.
   */
  async function staffDashboard() {
    const tasks = staffTasks ? await staffTasks.list() : [];
    const fittingRooms = store && Array.isArray(store.fittingRooms) ? store.fittingRooms : [];
    return {
      dashboard: 'staff-operations',
      incomingPickingRequests: tasks.map((t) => ({
        id: t.id,
        status: t.status,
        assignedTo: t.assignedTo,
        garments: (t.garments || []).map((g) => ({
          sku: g.sku, size: g.size, colour: g.colour, location: g.location,
        })),
      })),
      fittingRoomAvailability: fittingRooms.map((fr) => ({
        id: fr.id, zone: fr.zone, level: fr.level, capacity: fr.capacity,
      })),
      source: 'operational',
    };
  }

  /**
   * F15 Merchandising & Inventory Insights - presented as HUMAN
   * DECISION-SUPPORT, never as guaranteed forecasts or auto-reorder orders.
   */
  async function merchandisingInsights() {
    const aggregates = await gatherAggregates();
    const { unmet, byStyle, byZone } = aggregates;
    const insights = await aiAnalysis(aggregates);

    const result = {
      dashboard: 'merchandising-insights',
      decisionSupport: DECISION_SUPPORT_LABEL,
      insights: {
        frequentlyRequestedSizesMissing: {
          label: 'Frequently requested sizes missing from inventory',
          data: unmet.filter((r) => /size/.test(String(r.key))),
          interpretation: 'decision-support',
        },
        collectionsInterestVsPurchase: {
          label: 'Collections attracting interest but limited purchase',
          data: byStyle,
          interpretation: 'decision-support',
        },
        growingAttentionStyles: {
          label: 'Styles / colours getting growing attention',
          data: byStyle,
          interpretation: 'decision-support',
        },
        repeatedlySubstituted: {
          label: 'Products repeatedly substituted due to stock gaps',
          data: unmet,
          interpretation: 'decision-support',
        },
        popularHardToLocate: {
          label: 'Popular hard-to-locate items',
          data: byZone,
          interpretation: 'decision-support',
        },
      },
    };
    // AI analysis is ADDITIVE: the deterministic insight buckets above keep
    // their 'bigquery-aggregate'-derived numbers; the model only adds a
    // narrative/prediction/suggestion block labelled non-guaranteed.
    if (insights) result.aiAnalysis = insights;
    return result;
  }

  return {
    emit,
    sanitize,
    retailDashboard,
    staffDashboard,
    merchandisingInsights,
    shoppingIntent,
    productDemand,
    unmetDemand,
    inStoreExperience,
    commercialPerformance,
    PII_FIELDS,
    DECISION_SUPPORT_LABEL,
  };
}

module.exports = { createAnalytics, PII_FIELDS, DECISION_SUPPORT_LABEL, EVENTS_TABLE };
