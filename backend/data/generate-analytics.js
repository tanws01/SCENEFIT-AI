'use strict';

/**
 * Deterministic analytics-event generator for the retailer / staff dashboards.
 *
 * PURPOSE: produce a large, realistic, PRIVACY-PROTECTED set of analytics
 * events so the dashboards show real volume and variety (hundreds of events,
 * many categories, a multi-week trend) instead of a couple of counts.
 *
 * DETERMINISM: everything is driven by a tiny seeded LCG (no Math.random, no
 * Date.now, no network). Running this script always produces byte-identical
 * output, which we commit to backend/data/analyticsEvents.json. The server
 * never runs this at runtime - it only reads the committed static JSON, same
 * as before.
 *
 * PRIVACY: events carry NO PII. The only per-event identity is an anonymised,
 * non-identifying bucket id (anon-XXXX). This matches analytics.sanitize()'s
 * rules (PII_FIELDS stripped; privacy:{pii:false, aggregationReady:true}).
 *
 * The dimension vocabularies below are kept consistent with the seeded
 * catalogue / planogram / store data (real SKUs, real styles/colours/sizes,
 * real store zones) so the dashboard numbers line up with the rest of the app.
 *
 * Usage:
 *   env -u NODE_OPTIONS node backend/data/generate-analytics.js        # write file
 *   env -u NODE_OPTIONS node backend/data/generate-analytics.js --check # verify committed file is up to date
 */

const fs = require('node:fs');
const path = require('node:path');

const DATA_DIR = __dirname;
const OUT_FILE = path.join(DATA_DIR, 'analyticsEvents.json');

// ---- deterministic PRNG (Numerical Recipes LCG) -------------------------
function makeRng(seed) {
  let state = seed >>> 0;
  return function next() {
    // 32-bit LCG; returns a float in [0,1).
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

// ---- vocabularies (consistent with the seeded catalogue / store) --------
const OCCASIONS = [
  { key: 'beach', weight: 8 },
  { key: 'getaway', weight: 6 },
  { key: 'work', weight: 7 },
  { key: 'wedding-guest', weight: 4 },
  { key: 'date-night', weight: 5 },
  { key: 'casual-weekend', weight: 9 },
  { key: 'festival', weight: 3 },
  { key: 'brunch', weight: 4 },
];

const ENTRY_POINTS = [
  { key: 'style-my-moment', weight: 11 },
  { key: 'explore-whats-new', weight: 7 },
];

const STYLES = [
  { key: 'relaxed-tailoring', weight: 9 },
  { key: 'streetwear', weight: 8 },
  { key: 'resort', weight: 6 },
  { key: 'minimalist', weight: 7 },
  { key: 'casual', weight: 8 },
  { key: 'sporty', weight: 3 },
];

const COLOURS = [
  { key: 'black', weight: 9 },
  { key: 'white', weight: 8 },
  { key: 'navy', weight: 6 },
  { key: 'beige', weight: 5 },
  { key: 'olive', weight: 4 },
  { key: 'grey', weight: 4 },
  { key: 'brown', weight: 3 },
  { key: 'cream', weight: 3 },
];

const BUDGET_BANDS = [
  { key: 'RM0-80', weight: 2 },
  { key: 'RM80-150', weight: 4 },
  { key: 'RM150-200', weight: 6 },
  { key: 'RM200-250', weight: 7 },
  { key: 'RM250-350', weight: 5 },
  { key: 'RM350+', weight: 2 },
];

// Store zones (match store.json / planogram.json).
const ZONES = [
  { key: 'Zone B New Arrivals', weight: 10 },
  { key: 'Zone A Essentials', weight: 6 },
  { key: 'Zone C Footwear & Accessories', weight: 7 },
];

const IN_STORE_ACTIONS = [
  { key: 'rack_navigation_viewed', weight: 10 },
  { key: 'staff_assist_requested', weight: 5 },
  { key: 'fitting_room_queue_joined', weight: 4 },
  { key: 'fitting_room_session_completed', weight: 3 },
];

// Apparel SKUs that have real variant sizes (tops/bottoms/outerwear).
const APPAREL_SKUS = [
  'TOP-OXF-004', 'TOP-KNT-005', 'TOP-GRA-006', 'TOP-FLN-007',
  'BOT-TRS-012', 'BOT-CRG-013', 'BOT-DNM-014', 'OUT-BMB-031',
  'TOP-LIN-001', 'BOT-CHN-011',
];
const APPAREL_SIZES = [
  { key: 'XS', weight: 2 },
  { key: 'S', weight: 5 },
  { key: 'M', weight: 9 },
  { key: 'L', weight: 7 },
  { key: 'XL', weight: 5 },
  { key: 'XXL', weight: 3 },
];
const FOOTWEAR_SKUS = ['FTW-RUN-023', 'FTW-CNV-025', 'FTW-SNK-022', 'FTW-LOF-024'];
const FOOTWEAR_SIZES = [
  { key: '39', weight: 3 },
  { key: '40', weight: 6 },
  { key: '41', weight: 8 },
  { key: '42', weight: 7 },
  { key: '43', weight: 4 },
  { key: '44', weight: 2 },
];

const UNMET_REASONS = [
  { key: 'size_out_of_stock', weight: 10 },
  { key: 'budget_too_low_for_three_outfits', weight: 5 },
  { key: 'colour_unavailable', weight: 4 },
  { key: 'style_not_in_catalogue', weight: 3 },
  { key: 'item_sold_out', weight: 4 },
];

const COMMERCIAL_ACTIONS = [
  { key: 'recommendation_shown', weight: 14 },
  { key: 'saved_look', weight: 8 },
  { key: 'add_to_cart', weight: 7 },
  { key: 'try_on', weight: 6 },
  { key: 'checkout_handoff', weight: 4 },
];

// ---- helpers ------------------------------------------------------------
function weightedPick(rng, items) {
  const total = items.reduce((s, i) => s + i.weight, 0);
  let r = rng() * total;
  for (const it of items) {
    r -= it.weight;
    if (r < 0) return it.key;
  }
  return items[items.length - 1].key;
}

function anonId(rng) {
  // Non-identifying 4-hex bucket; collisions are fine and expected (buckets).
  const n = Math.floor(rng() * 0x10000);
  return `anon-${n.toString(16).padStart(4, '0')}`;
}

// Six weeks of history ending Fri 2025-04-25. Each week has a Monday anchor.
const WEEK_STARTS = [
  '2025-03-17', '2025-03-24', '2025-03-31',
  '2025-04-07', '2025-04-14', '2025-04-21',
];

function isoFor(weekIdx, rng) {
  const base = new Date(`${WEEK_STARTS[weekIdx]}T00:00:00Z`);
  const dayOffset = Math.floor(rng() * 7); // 0..6
  const hour = 9 + Math.floor(rng() * 11); // 09:00..19:00 trading hours
  const minute = Math.floor(rng() * 60);
  const d = new Date(base.getTime());
  d.setUTCDate(d.getUTCDate() + dayOffset);
  d.setUTCHours(hour, minute, 0, 0);
  return d.toISOString();
}

// Gentle upward trend in weekly volume so the time-series looks real.
const WEEK_VOLUME = [40, 46, 52, 58, 66, 74];

function build() {
  const rng = makeRng(20250425);
  const events = [];
  let seq = 0;
  const id = () => `evt-${(++seq).toString().padStart(4, '0')}`;

  for (let w = 0; w < WEEK_STARTS.length; w += 1) {
    const n = WEEK_VOLUME[w];
    for (let i = 0; i < n; i += 1) {
      const roll = rng();
      let ev;
      if (roll < 0.26) {
        // intent
        ev = {
          type: 'intent',
          occasion: weightedPick(rng, OCCASIONS),
          entryPoint: weightedPick(rng, ENTRY_POINTS),
          budgetBand: weightedPick(rng, BUDGET_BANDS),
        };
      } else if (roll < 0.46) {
        // demand (style + colour)
        ev = {
          type: 'demand',
          style: weightedPick(rng, STYLES),
          colour: weightedPick(rng, COLOURS),
        };
      } else if (roll < 0.60) {
        // unmet_demand
        const reason = weightedPick(rng, UNMET_REASONS);
        ev = { type: 'unmet_demand', reason };
        if (reason === 'size_out_of_stock') {
          const footwear = rng() < 0.35;
          const sku = footwear
            ? FOOTWEAR_SKUS[Math.floor(rng() * FOOTWEAR_SKUS.length)]
            : APPAREL_SKUS[Math.floor(rng() * APPAREL_SKUS.length)];
          ev.sku = sku;
          ev.requestedSize = weightedPick(rng, footwear ? FOOTWEAR_SIZES : APPAREL_SIZES);
        } else if (reason === 'colour_unavailable') {
          ev.colour = weightedPick(rng, COLOURS);
        } else if (reason === 'budget_too_low_for_three_outfits') {
          ev.budgetBand = 'RM0-80';
        } else if (reason === 'style_not_in_catalogue') {
          ev.requestedStyle = weightedPick(rng, STYLES);
        } else {
          ev.sku = APPAREL_SKUS[Math.floor(rng() * APPAREL_SKUS.length)];
        }
      } else if (roll < 0.78) {
        // in_store
        const action = weightedPick(rng, IN_STORE_ACTIONS);
        ev = { type: 'in_store', zone: weightedPick(rng, ZONES), action };
        if (action === 'rack_navigation_viewed') {
          const pool = APPAREL_SKUS.concat(FOOTWEAR_SKUS);
          ev.sku = pool[Math.floor(rng() * pool.length)];
        }
      } else {
        // commercial
        const action = weightedPick(rng, COMMERCIAL_ACTIONS);
        ev = { type: 'commercial', action };
        if (action === 'checkout_handoff' || action === 'add_to_cart') {
          const items = 1 + Math.floor(rng() * 3); // 1..3
          const value = 80 + Math.floor(rng() * 320); // RM80..RM399
          ev.itemCount = items;
          ev.valueRm = Number(value.toFixed(2));
        }
      }
      ev.id = id();
      ev.timestamp = isoFor(w, rng);
      ev.week = WEEK_STARTS[w];
      ev.anonUserId = anonId(rng);
      ev.privacy = { pii: false, aggregationReady: true };
      events.push(ev);
    }
  }

  // Stable ordering by timestamp then id so the committed file is canonical.
  events.sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : (a.id < b.id ? -1 : 1)));
  return events;
}

function serialise(events) {
  return `${JSON.stringify(events, null, 2)}\n`;
}

function main() {
  const events = build();
  const text = serialise(events);
  const check = process.argv.includes('--check');
  if (check) {
    const current = fs.existsSync(OUT_FILE) ? fs.readFileSync(OUT_FILE, 'utf8') : '';
    if (current !== text) {
      process.stderr.write('analyticsEvents.json is OUT OF DATE. Re-run the generator.\n');
      process.exit(1);
    }
    process.stdout.write(`analyticsEvents.json is up to date (${events.length} events).\n`);
    return;
  }
  fs.writeFileSync(OUT_FILE, text);
  process.stdout.write(`Wrote ${events.length} events to ${OUT_FILE}\n`);
}

if (require.main === module) main();

module.exports = { build, serialise };
