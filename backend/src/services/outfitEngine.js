'use strict';

/**
 * Outfit engine - F04 (three coordinated outfits) + F07 (catalogue/pricing/
 * inventory validation). This module is the heart of the two success metrics:
 *
 *   1. 100% of displayed purchasable recommendations respect the budget cap.
 *   2. 100% of purchasable items reference a valid catalogue SKU.
 *
 * BOUNDARY PRINCIPLE (enforced here, rigorously):
 *   "Gemini generates understanding and recommendations;
 *    the application validates retail facts."
 *
 * Gemini's proposeOutfits() returns outfit CONCEPTS ONLY (names, slot roles,
 * candidate SKU references, styling rationale). That output is UNTRUSTED. For
 * every concept this engine:
 *   - resolves each referenced SKU against catalogue.js (SOURCE OF TRUTH);
 *   - REJECTS any concept referencing a non-existent SKU;
 *   - computes per-item price and the outfit total FROM CATALOGUE ONLY;
 *   - enforces the budget cap deterministically (drops/replaces over-budget);
 *   - enforces stock + size availability;
 *   - guarantees exactly three MEANINGFULLY-DIFFERENT valid outfits;
 *   - when three valid budget-compliant distinct outfits cannot be formed,
 *     returns {status:'insufficient', formed, alternatives, message} WITHOUT
 *     inventing products.
 *
 * The engine never trusts a price, stock figure, or SKU that originates in a
 * concept; it only uses the concept as a styling *hint*. It can also assemble
 * valid outfits deterministically from the candidate pool when concepts are
 * missing, invalid, or over budget - so output is always 100% valid.
 */

const TARGET_OUTFITS = 3;
const ACTION_BUTTONS = Object.freeze([
  'tryOn', 'compare', 'swap', 'save', 'findInStore', 'shop',
]);

/**
 * @param {object} deps
 * @param {object} deps.catalogue catalogue service (source of truth)
 * @param {object} deps.gemini gemini adapter (untrusted stylist)
 * @param {object} [deps.storage] cloud storage adapter (image refs)
 */
function createOutfitEngine(deps = {}) {
  const { catalogue, gemini } = deps;
  const storage = deps.storage;
  if (!catalogue) throw new Error('outfitEngine requires a catalogue service');
  if (!gemini) throw new Error('outfitEngine requires a gemini adapter');

  /**
   * Produce coordinated outfit recommendations for a parsed intent.
   *
   * @param {object} intent parsed intent (untrusted interpretation)
   * @param {object} [options]
   * @param {object} [options.profile] optional style profile
   * @param {Array} [options.concepts] inject pre-built gemini concepts (tests)
   * @param {Array} [options.candidatePool] inject a candidate pool (tests)
   * @returns {Promise<object>} recommendation result
   */
  async function recommend(intent, options = {}) {
    const profile = options.profile || {};
    const budgetRm = resolveBudget(intent);
    const preferredSize = resolvePreferredSize(intent, profile);

    // 1. Deterministic, catalogue-backed candidate pool (valid, in-stock SKUs).
    const candidatePool = options.candidatePool
      || await catalogue.filterCandidates(intent, profile);

    // 2. Ask Gemini (untrusted) to arrange the pool into styling concepts.
    let concepts = options.concepts;
    if (!concepts) {
      try {
        concepts = await gemini.proposeOutfits(intent, candidatePool);
      } catch (_err) {
        concepts = [];
      }
    }
    concepts = Array.isArray(concepts) ? concepts : [];

    // 3. Validate each concept against the catalogue; keep only outfits whose
    //    every item resolves to a real, in-stock, budget-compliant SKU.
    const validated = [];
    const rejected = [];
    for (const concept of concepts) {
      const built = await buildFromConcept(concept, { budgetRm, preferredSize });
      if (built.ok) {
        validated.push(built.outfit);
      } else {
        rejected.push({ conceptId: concept && concept.conceptId, reasons: built.reasons });
      }
    }

    // 4. Guarantee exactly three MEANINGFULLY-DIFFERENT valid outfits. Concepts
    //    may be too few, duplicated, invalid, or over budget - so top up with a
    //    deterministic assembly from the (validated-only) candidate pool.
    let outfits = dedupeDistinct(validated);
    if (outfits.length < TARGET_OUTFITS) {
      const assembled = await assembleOutfits(candidatePool, {
        budgetRm,
        preferredSize,
        exclude: outfits,
        intent,
      });
      for (const outfit of assembled) {
        if (outfits.length >= TARGET_OUTFITS) break;
        if (isDistinctFrom(outfit, outfits)) outfits.push(outfit);
      }
    }
    outfits = outfits.slice(0, TARGET_OUTFITS);

    // 5. Final re-validation guard. Nothing non-compliant ever leaves here.
    for (const outfit of outfits) {
      assertCompliant(outfit, budgetRm);
    }

    if (outfits.length < TARGET_OUTFITS) {
      return await insufficient(outfits, {
        intent,
        budgetRm,
        preferredSize,
        candidatePool,
        rejected,
      });
    }

    // 6. Attach styling rationale (Gemini, labelled as suggestion) + previews.
    const enriched = [];
    for (const outfit of outfits) {
      enriched.push(await finalizeOutfit(outfit, { intent }));
    }

    return {
      status: 'ok',
      budget: budgetRm != null ? { amountRm: budgetRm, currency: 'RM' } : null,
      outfits: enriched,
      meta: {
        candidatePoolSize: candidatePool.length,
        conceptsProposed: concepts.length,
        conceptsRejected: rejected.length,
        rejected,
        source: 'outfit-engine',
      },
    };
  }

  /**
   * Build and validate a single outfit from an untrusted Gemini concept.
   * Returns {ok:false, reasons:[...]} if ANY slot references an invalid SKU,
   * an out-of-stock variant, or the outfit total exceeds the budget cap.
   */
  async function buildFromConcept(concept, { budgetRm, preferredSize }) {
    const reasons = [];
    if (!concept || !Array.isArray(concept.slots) || concept.slots.length < 2) {
      return { ok: false, reasons: ['concept has too few slots'] };
    }

    const items = [];
    const seenSkus = new Set();
    for (const slot of concept.slots) {
      const sku = slot && slot.candidateSku;
      // Validate SKU against the catalogue (SOURCE OF TRUTH). Reject unknowns.
      const product = await catalogue.getProduct(sku);
      if (!product) {
        reasons.push(`invalid SKU: ${sku}`);
        continue;
      }
      if (seenSkus.has(product.sku)) continue; // ignore duplicate slot
      const item = await resolveItem(product, slot.role, preferredSize);
      if (!item) {
        reasons.push(`no in-stock variant for SKU: ${sku}`);
        continue;
      }
      seenSkus.add(product.sku);
      items.push(item);
    }

    const complete = hasRequiredRoles(items);
    if (!complete) reasons.push('outfit missing required roles (needs top+bottom+footwear)');

    const total = sumPrices(items);
    if (budgetRm != null && total > budgetRm) {
      reasons.push(`over budget: total RM${total} > RM${budgetRm}`);
    }

    if (reasons.length) return { ok: false, reasons };

    return {
      ok: true,
      outfit: makeOutfit({
        name: (concept && concept.name) || null,
        theme: (concept && concept.theme) || themeFromItems(items),
        styleLabel: concept && concept.styleLabel,
        rationaleHint: concept && concept.rationale,
        conceptId: concept && concept.conceptId,
        items,
        total,
      }),
    };
  }

  /**
   * Deterministically assemble valid, budget-compliant outfits from the
   * candidate pool WITHOUT any AI input. Guarantees validity by construction:
   * every item is a real, in-stock catalogue SKU and the total is computed from
   * catalogue prices and checked against the cap. Never invents products.
   */
  async function assembleOutfits(candidatePool, { budgetRm, preferredSize, exclude, intent }) {
    const byCat = await resolveByCategory(candidatePool, preferredSize);
    const tops = byCat.top;
    const bottoms = byCat.bottom;
    const footwear = byCat.footwear;

    // Cheapest-first ordering makes budget satisfaction deterministic and
    // maximises how many valid outfits we can form under a tight cap.
    const sortByPrice = (a, b) => a.priceRm - b.priceRm || a.sku.localeCompare(b.sku);
    tops.sort(sortByPrice);
    bottoms.sort(sortByPrice);
    footwear.sort(sortByPrice);

    const results = [];
    const usedTops = new Set();
    const usedBottoms = new Set();
    const usedFootwear = new Set();
    for (const o of exclude || []) {
      for (const it of o.items) {
        if (it.role === 'top') usedTops.add(it.sku);
        if (it.role === 'bottom') usedBottoms.add(it.sku);
        if (it.role === 'footwear') usedFootwear.add(it.sku);
      }
    }

    // First pass: build meaningfully-different outfits by consuming distinct
    // hero pieces (top), bottom, and footwear per outfit.
    for (const top of tops) {
      if (results.length >= TARGET_OUTFITS) break;
      if (usedTops.has(top.sku)) continue;
      const bottom = bottoms.find((b) => !usedBottoms.has(b.sku));
      const shoe = footwear.find((f) => !usedFootwear.has(f.sku));
      if (!bottom || !shoe) break;

      const items = [top, bottom, shoe];
      const total = sumPrices(items);
      if (budgetRm != null && total > budgetRm) {
        // Try to swap in cheaper pieces to meet the cap deterministically.
        const trimmed = trimToBudget(items, { tops, bottoms, footwear, usedTops, usedBottoms, usedFootwear, budgetRm });
        if (!trimmed) continue;
        results.push(toAssembledOutfit(trimmed, intent));
        markUsed(trimmed, usedTops, usedBottoms, usedFootwear);
        continue;
      }
      results.push(toAssembledOutfit(items, intent));
      markUsed(items, usedTops, usedBottoms, usedFootwear);
    }

    return results;
  }

  /**
   * Attempt to bring an over-budget triple under the cap by swapping each slot
   * for the cheapest available alternative. Returns null if impossible.
   */
  function trimToBudget(items, ctx) {
    const { tops, bottoms, footwear, usedTops, usedBottoms, usedFootwear, budgetRm } = ctx;
    const cheapest = {
      top: tops.find((t) => !usedTops.has(t.sku)),
      bottom: bottoms.find((b) => !usedBottoms.has(b.sku)),
      footwear: footwear.find((f) => !usedFootwear.has(f.sku)),
    };
    const candidate = [cheapest.top, cheapest.bottom, cheapest.footwear];
    if (candidate.some((x) => !x)) return null;
    if (sumPrices(candidate) > budgetRm) return null;
    return candidate;
  }

  function markUsed(items, usedTops, usedBottoms, usedFootwear) {
    for (const it of items) {
      if (it.role === 'top') usedTops.add(it.sku);
      if (it.role === 'bottom') usedBottoms.add(it.sku);
      if (it.role === 'footwear') usedFootwear.add(it.sku);
    }
  }

  function toAssembledOutfit(items, intent) {
    const total = sumPrices(items);
    return makeOutfit({
      name: null,
      theme: themeFromItems(items, intent),
      styleLabel: pickStyleLabel(items),
      rationaleHint: null,
      conceptId: null,
      items: items.map((i) => ({ ...i })),
      total,
    });
  }

  /**
   * Resolve a product into a validated outfit item (role, price, size, stock).
   * Returns null when no in-stock variant exists. Price ALWAYS from catalogue.
   */
  async function resolveItem(product, role, preferredSize) {
    const sizes = await catalogue.getAvailableSizes(product.sku);
    if (!sizes.length) return null;
    const size = sizes.includes(String(preferredSize)) ? String(preferredSize) : sizes[0];
    const price = await catalogue.getPrice(product.sku);
    if (price == null) return null;
    return {
      sku: product.sku,
      role: role || product.category,
      name: product.name,
      category: product.category,
      colour: product.colour,
      priceRm: price,
      size,
      availableSizes: sizes,
      inStock: true,
      image: product.image || null,
    };
  }

  async function resolveByCategory(candidatePool, preferredSize) {
    const out = { top: [], bottom: [], footwear: [], outerwear: [], accessory: [] };
    for (const c of candidatePool) {
      const product = await catalogue.getProduct(c.sku);
      if (!product) continue; // defensive: pool is catalogue-backed already
      const item = await resolveItem(product, product.category, preferredSize);
      if (!item) continue;
      if (out[item.category]) out[item.category].push(item);
    }
    return out;
  }

  /**
   * Build the final insufficient fallback. Offers alternatives drawn ONLY from
   * real catalogue items (the valid pieces we could resolve) - never invents.
   */
  async function insufficient(formedOutfits, ctx) {
    const { budgetRm, preferredSize, candidatePool, intent } = ctx;
    const byCat = await resolveByCategory(candidatePool, preferredSize);

    // Cheapest real pieces per category, as concrete alternatives.
    const cheapest = [];
    for (const cat of ['top', 'bottom', 'footwear', 'outerwear', 'accessory']) {
      const list = byCat[cat].slice().sort((a, b) => a.priceRm - b.priceRm);
      if (list[0]) cheapest.push(list[0]);
    }
    const minTriplePrice = minThreePieceTotal(byCat);

    const enrichedFormed = [];
    for (const outfit of formedOutfits) {
      enrichedFormed.push(await finalizeOutfit(outfit, { intent }));
    }

    const message = budgetRm != null
      ? `We could not build ${TARGET_OUTFITS} complete outfits within RM${budgetRm}. `
        + (minTriplePrice != null
          ? `The most affordable complete outfit from the current catalogue is RM${minTriplePrice}. `
          : '')
        + 'Here are real catalogue pieces you could start from - we never suggest items we do not actually stock.'
      : `We could not build ${TARGET_OUTFITS} complete outfits from the current catalogue. `
        + 'Here are real catalogue pieces you could start from.';

    return {
      status: 'insufficient',
      budget: budgetRm != null ? { amountRm: budgetRm, currency: 'RM' } : null,
      formed: enrichedFormed.length,
      outfits: enrichedFormed,
      alternatives: cheapest.map((item) => ({
        sku: item.sku,
        name: item.name,
        role: item.role,
        colour: item.colour,
        priceRm: item.priceRm,
        availableSizes: item.availableSizes,
        image: item.image,
        note: 'Real catalogue item - adjust budget or mix with owned pieces to complete a look.',
      })),
      minCompleteOutfitRm: minTriplePrice,
      message,
      meta: { source: 'outfit-engine', invented: false },
    };
  }

  /**
   * Finalize an outfit for presentation: structure pieces/footwear/accessories,
   * attach Gemini styling explanation (labelled suggestion), image refs, and
   * action-button metadata.
   */
  async function finalizeOutfit(outfit, { intent }) {
    let explanation = outfit.rationaleHint;
    try {
      const ex = await gemini.explainOutfit({
        conceptId: outfit.conceptId,
        name: outfit.name,
        rationale: outfit.rationaleHint || defaultRationale(outfit, intent),
      });
      if (ex && ex.explanation) explanation = ex.explanation;
    } catch (_err) {
      explanation = outfit.rationaleHint || defaultRationale(outfit, intent);
    }

    const pieces = outfit.items.filter((i) => i.category === 'top' || i.category === 'bottom' || i.category === 'outerwear');
    const footwear = outfit.items.filter((i) => i.category === 'footwear');
    const accessories = outfit.items.filter((i) => i.category === 'accessory');

    const skus = outfit.items.map((i) => i.sku);
    let previewImageRef = null;
    if (storage && typeof storage.getSignedUrl === 'function') {
      try {
        const key = `outfits/${outfit.id}.png`;
        const signed = await storage.getSignedUrl(key);
        previewImageRef = signed && signed.url ? signed.url : null;
      } catch (_err) {
        previewImageRef = null;
      }
    }

    return {
      id: outfit.id,
      name: outfit.name,
      theme: outfit.theme,
      styleLabel: outfit.styleLabel,
      items: outfit.items.map((i) => ({
        sku: i.sku,
        role: i.role,
        name: i.name,
        category: i.category,
        colour: i.colour,
        priceRm: i.priceRm,
        size: i.size,
        availableSizes: i.availableSizes,
        inStock: i.inStock,
        image: i.image,
      })),
      pieces: pieces.map((i) => i.sku),
      footwear: footwear.map((i) => i.sku),
      accessories: accessories.map((i) => i.sku),
      totalPriceRm: outfit.totalPriceRm,
      budgetCompliant: outfit.budgetCompliant,
      availability: 'in_stock',
      // Styling explanation is a Gemini-authored SUGGESTION, not a retail fact.
      rationale: explanation,
      rationaleSource: 'gemini (suggestion)',
      fitNote: null,
      previewImageRef,
      actionButtons: ACTION_BUTTONS.slice(),
      skus,
    };
  }

  return { recommend };
}

/* ---------------------------- pure helpers ------------------------------- */

const REQUIRED_ROLES = ['top', 'bottom', 'footwear'];

function hasRequiredRoles(items) {
  const cats = new Set(items.map((i) => i.category));
  return REQUIRED_ROLES.every((r) => cats.has(r));
}

function sumPrices(items) {
  return round2(items.reduce((acc, i) => acc + Number(i.priceRm || 0), 0));
}

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

function resolveBudget(intent) {
  if (intent && intent.budget && Number.isFinite(Number(intent.budget.amountRm))) {
    return Number(intent.budget.amountRm);
  }
  return null;
}

function resolvePreferredSize(intent, profile) {
  const fromIntent = intent && Array.isArray(intent.sizes) ? intent.sizes.find((s) => /^(xs|s|m|l|xl|xxl)$/i.test(String(s))) : null;
  if (fromIntent) return String(fromIntent).toUpperCase();
  if (profile && profile.sizes && profile.sizes.top) return String(profile.sizes.top).toUpperCase();
  if (profile && Array.isArray(profile.preferredSizes) && profile.preferredSizes[0]) {
    return String(profile.preferredSizes[0]).toUpperCase();
  }
  return 'M';
}

function makeOutfit({ name, theme, styleLabel, rationaleHint, conceptId, items, total }) {
  const id = `outfit-${items.map((i) => i.sku).join('_')}`;
  const budgetCompliant = true; // only compliant outfits reach makeOutfit
  return {
    id,
    name: name || buildName(styleLabel, theme, items),
    theme: theme || 'occasion',
    styleLabel: styleLabel || pickStyleLabel(items),
    rationaleHint: rationaleHint || null,
    conceptId: conceptId || null,
    items,
    totalPriceRm: round2(total),
    budgetCompliant,
  };
}

function buildName(styleLabel, theme, items) {
  const hero = items.find((i) => i.category === 'top') || items[0];
  const label = capitalize(styleLabel || (theme === 'latest-arrivals' ? 'relaxed-tailoring' : 'effortless'));
  return `${label} look with ${hero ? hero.name : 'coordinated pieces'}`;
}

function pickStyleLabel(items) {
  const counts = new Map();
  for (const i of items) {
    for (const s of i.styles || []) counts.set(s, (counts.get(s) || 0) + 1);
  }
  let best = null;
  let bestN = 0;
  for (const [s, n] of counts) {
    if (n > bestN) { best = s; bestN = n; }
  }
  return best || 'effortless';
}

function themeFromItems(items, intent) {
  if (intent && intent.wantsLatestCollection) return 'latest-arrivals';
  return 'occasion';
}

function defaultRationale(outfit, intent) {
  const occasion = intent && Array.isArray(intent.occasions) && intent.occasions.length
    ? intent.occasions.join(' / ')
    : null;
  const base = occasion
    ? `Coordinated for a ${occasion} occasion`
    : (intent && intent.wantsLatestCollection ? 'Built around current new arrivals' : 'An easy coordinated look');
  return `${base}; the pieces share a consistent tone and silhouette.`;
}

/**
 * Keep only outfits that are MEANINGFULLY DIFFERENT (distinct SKU sets with at
 * least one differing hero/anchor piece).
 */
function dedupeDistinct(outfits) {
  const kept = [];
  for (const o of outfits) {
    if (isDistinctFrom(o, kept)) kept.push(o);
  }
  return kept;
}

function isDistinctFrom(outfit, others) {
  const key = new Set(outfit.items.map((i) => i.sku));
  for (const o of others) {
    const otherKey = new Set(o.items.map((i) => i.sku));
    // Identical SKU set -> not distinct.
    if (key.size === otherKey.size && [...key].every((s) => otherKey.has(s))) return false;
    // Share the same top AND bottom -> not meaningfully different.
    const sameTop = sameRoleSku(outfit, o, 'top');
    const sameBottom = sameRoleSku(outfit, o, 'bottom');
    if (sameTop && sameBottom) return false;
  }
  return true;
}

function sameRoleSku(a, b, role) {
  const sa = (a.items.find((i) => i.role === role || i.category === role) || {}).sku;
  const sb = (b.items.find((i) => i.role === role || i.category === role) || {}).sku;
  return sa && sb && sa === sb;
}

function minThreePieceTotal(byCat) {
  const cheapest = (arr) => (arr.length ? arr.slice().sort((a, b) => a.priceRm - b.priceRm)[0].priceRm : null);
  const t = cheapest(byCat.top);
  const b = cheapest(byCat.bottom);
  const f = cheapest(byCat.footwear);
  if (t == null || b == null || f == null) return null;
  return round2(t + b + f);
}

/**
 * Final hard guard. Throws if an outfit is ever non-compliant - this must never
 * happen because only validated outfits reach here, but the guard makes the
 * "100% valid / 100% within budget" contract explicit and self-checking.
 */
function assertCompliant(outfit, budgetRm) {
  if (!hasRequiredRoles(outfit.items)) {
    throw new Error(`outfit ${outfit.id} missing required roles`);
  }
  const recomputed = sumPrices(outfit.items);
  if (recomputed !== outfit.totalPriceRm) {
    throw new Error(`outfit ${outfit.id} total mismatch`);
  }
  if (budgetRm != null && recomputed > budgetRm) {
    throw new Error(`outfit ${outfit.id} over budget RM${recomputed} > RM${budgetRm}`);
  }
}

function capitalize(s) {
  const str = String(s || '');
  return str.charAt(0).toUpperCase() + str.slice(1);
}

module.exports = { createOutfitEngine, ACTION_BUTTONS, TARGET_OUTFITS };
