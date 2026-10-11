'use strict';

/**
 * Style & preference profile service - F03.
 *
 * All fields are OPTIONAL and editable. The profile influences
 * catalogue.filterCandidates (preferred/avoided colours, preferred styles,
 * sizes by category, budget preference) but never overrides a mandatory
 * constraint stated in a request (e.g. an explicit budget in the utterance).
 *
 * Persisted via the Firestore adapter (deterministic mock offline).
 */

const COLLECTION = 'styleProfiles';

/** Canonical empty profile shape. */
function emptyProfile(userId) {
  return {
    userId: userId || null,
    preferredStyles: [],
    preferredColours: [],
    avoidedColours: [],
    sizes: {}, // { top:'M', bottom:'M', footwear:'42', accessory:'OS' }
    fitPreference: null, // 'slim' | 'regular' | 'relaxed'
    budgetPrefRm: null,
    preferredBrands: [],
    savedLooks: [], // array of outfit ids / snapshots
    wardrobeItems: [], // owned items (see wardrobe.js)
  };
}

const EDITABLE_FIELDS = Object.freeze([
  'preferredStyles', 'preferredColours', 'avoidedColours', 'sizes',
  'fitPreference', 'budgetPrefRm', 'preferredBrands', 'savedLooks', 'wardrobeItems',
]);

/**
 * @param {object} deps
 * @param {object} deps.firestore firestore adapter
 */
function createStyleProfile(deps = {}) {
  const firestore = deps.firestore;
  if (!firestore) throw new Error('styleProfile requires a firestore adapter');

  /**
   * Get a profile, returning a canonical empty profile when none exists.
   * @param {string} userId
   */
  async function get(userId) {
    const stored = await firestore.get(COLLECTION, userId);
    if (!stored) return emptyProfile(userId);
    return { ...emptyProfile(userId), ...stored, userId };
  }

  /**
   * Merge a partial update into the stored profile. Only known editable fields
   * are accepted; unknown fields are ignored (defensive against junk input).
   * @param {string} userId
   * @param {object} patch
   */
  async function update(userId, patch = {}) {
    const current = await get(userId);
    const next = { ...current };
    for (const field of EDITABLE_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(patch, field)) {
        next[field] = patch[field];
      }
    }
    next.userId = userId;
    await firestore.set(COLLECTION, userId, next);
    return next;
  }

  /** Save a look (outfit snapshot) to the profile. */
  async function saveLook(userId, look) {
    const current = await get(userId);
    const savedLooks = Array.isArray(current.savedLooks) ? current.savedLooks.slice() : [];
    if (!savedLooks.some((l) => (l && l.id) === (look && look.id))) {
      savedLooks.push(look);
    }
    return update(userId, { savedLooks });
  }

  return { get, update, saveLook, emptyProfile };
}

module.exports = { createStyleProfile, EDITABLE_FIELDS, emptyProfile };
