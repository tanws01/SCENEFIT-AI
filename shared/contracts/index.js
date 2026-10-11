'use strict';

/**
 * SCENEFIT AI shared contracts.
 *
 * Plain JSDoc typedefs plus lightweight example/shape objects that the
 * frontend and backend agree on. Kept dependency-free (no JSON Schema library)
 * so it can be required from either side or inspected as data.
 *
 * BOUNDARY REMINDER: fields produced by Gemini (concepts, rationale, intent)
 * are UNTRUSTED suggestions. Authoritative retail facts (priceRm, stock,
 * availability, rack location, queue confirmation, collection dates) are only
 * ever set by deterministic application services.
 */

/**
 * @typedef {Object} Budget
 * @property {number} amountRm
 * @property {'RM'} currency
 */

/**
 * @typedef {Object} Intent
 * Structured interpretation of a shopper utterance (produced by Gemini mock).
 * @property {string} rawUtterance
 * @property {'style-my-moment'|'explore-whats-new'} entryPoint
 * @property {boolean} wantsLatestCollection
 * @property {string[]} occasions
 * @property {string[]} activities
 * @property {string[]} styles
 * @property {string[]} colours
 * @property {string[]} sizes
 * @property {Budget|null} budget
 * @property {{preferredSizes:string[], preferredColours:string[]}} profileHints
 * @property {number} confidence   model-side only; NOT a retail fact
 * @property {string} source
 */

/**
 * @typedef {Object} OutfitItem
 * A validated item within a recommendation. Retail facts here are set by the
 * application, not by Gemini.
 * @property {string} sku
 * @property {string} role        e.g. 'top' | 'bottom' | 'footwear' | 'outerwear' | 'accessory'
 * @property {string} name
 * @property {number} priceRm     application-owned retail fact
 * @property {string} size
 * @property {boolean} inStock    application-owned retail fact
 */

/**
 * @typedef {Object} OutfitRecommendation
 * @property {string} id
 * @property {string} name
 * @property {string} theme
 * @property {OutfitItem[]} items
 * @property {number} totalPriceRm  application-owned sum of item prices
 * @property {boolean} budgetCompliant application-owned validation result
 * @property {string} rationale     Gemini-authored styling rationale (suggestion)
 */

/**
 * @typedef {Object} QueueTicket
 * Fitting-room queue ticket (F11). The status strings are the canonical state
 * machine names in backend/src/services/fittingRoomQueue.js. A ticket is NEVER
 * 'Confirmed' until the retailer's operational system confirms it; `confirmed`
 * is an application/operational fact, never AI-supplied.
 * @property {string} id
 * @property {string} storeId
 * @property {string|null} fittingRoomId
 * @property {'Requested'|'Confirmed'|'Picking Items'|'Waiting for Room'|'Ready'|'In Fitting Room'|'Completed'|'UnavailableItems'|'DelayedPreparation'|'CustomerCancelled'|'NoShow'|'ExpiredTicket'} status
 * @property {boolean} confirmed
 * @property {Array<{sku:string,size:string,colour:string}>} items
 * @property {string} liveStatusMessage
 * @property {string} issuedAt
 */

/**
 * @typedef {Object} StaffTask
 * Staff-assisted product collection picking task (F10). Status strings are the
 * canonical lifecycle in backend/src/services/staffTasks.js.
 * @property {string} id
 * @property {string} storeId
 * @property {'pull_items'} type
 * @property {'Submitted'|'Accepted'|'Rejected'|'Preparing'|'ReadyForCollection'|'Completed'} status
 * @property {Array<{sku:string,size:string,colour:string,name:string,available:boolean,location:object}>} garments
 * @property {string|null} assignedTo
 * @property {string} customerStatus
 * @property {string} createdAt
 */

/**
 * @typedef {Object} AnalyticsEvent
 * Privacy-protected (no PII), aggregation-ready analytics event.
 * @property {string} id
 * @property {'intent'|'demand'|'unmet_demand'|'in_store'|'commercial'} type
 * @property {string} timestamp
 * @property {string} anonUserId
 * @property {{pii:boolean, aggregationReady:boolean}} privacy
 */

/** Example shapes (handy for frontend mocks and schema-style validation). */
const EXAMPLES = Object.freeze({
  intent: {
    rawUtterance: '',
    entryPoint: 'style-my-moment',
    wantsLatestCollection: false,
    occasions: [],
    activities: [],
    styles: [],
    colours: [],
    sizes: [],
    budget: null,
    profileHints: { preferredSizes: [], preferredColours: [] },
    confidence: 0,
    source: '',
  },
  outfitRecommendation: {
    id: '',
    name: '',
    theme: '',
    items: [],
    totalPriceRm: 0,
    budgetCompliant: true,
    rationale: '',
  },
  outfitItem: {
    sku: '', role: '', name: '', priceRm: 0, size: '', inStock: true,
  },
  queueTicket: {
    id: '', storeId: '', fittingRoomId: null, status: 'Requested', confirmed: false,
    items: [], liveStatusMessage: '', issuedAt: '',
  },
  staffTask: {
    id: '', storeId: '', type: 'pull_items', status: 'Submitted', garments: [],
    assignedTo: null, customerStatus: '', createdAt: '',
  },
  analyticsEvent: {
    id: '', type: 'intent', timestamp: '', anonUserId: '', privacy: { pii: false, aggregationReady: true },
  },
});

module.exports = { EXAMPLES };
