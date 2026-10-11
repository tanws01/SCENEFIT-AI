'use strict';

/**
 * Offline tests for the deterministic scene feature (FEAT-002).
 *
 * The scene is a parse of the utterance - a model-side interpretation only.
 * It drives the Shop page background and must NEVER carry a retail fact
 * (price/stock/location/queue/date). Scene background SVGs are synthesised
 * inline by static.js (no files on disk, no network), with a 'studio' fallback
 * so the UI background is never a 404.
 */

const { test } = require('node:test');
const assert = require('node:assert');

const { loadConfig } = require('../src/config');
const { createAdapters } = require('../src/adapters');
const { createConversation } = require('../src/services/conversation');
const { FORBIDDEN_RETAIL_FIELDS } = require('../src/adapters/gemini');
const { sceneSvg } = require('../src/static');

function build() {
  const adapters = createAdapters(loadConfig({}));
  const conversation = createConversation({
    gemini: adapters.gemini,
    speech: adapters.speech,
    firestore: adapters.firestore,
  });
  return { adapters, conversation };
}

test('Batu Ferringhi beach prompt yields the beach scene with the place preserved', async () => {
  const { conversation } = build();
  const session = await conversation.startSession({});
  const res = await conversation.handleMessage(session.id, {
    text: 'sunset dinner at Batu Ferringhi beach, budget RM250, size M',
  });
  assert.ok(res.intent.scene, 'intent carries a scene');
  assert.strictEqual(res.intent.scene.id, 'beach');
  assert.ok(
    typeof res.intent.scene.place === 'string'
      && res.intent.scene.place.includes('batu ferringhi'),
    'the specific matched place is preserved in scene.place'
  );
  assert.strictEqual(res.intent.scene.source, 'gemini-mock');
});

test('a latest-arrivals / no-place prompt falls back to the studio scene', async () => {
  const { conversation } = build();
  const session = await conversation.startSession({});
  const res = await conversation.handleMessage(session.id, {
    text: "Show me what's new, keep it under RM300, size L",
  });
  assert.ok(res.intent.scene);
  assert.strictEqual(res.intent.scene.id, 'studio');
  assert.strictEqual(res.intent.scene.place, undefined, 'no place when none mentioned');
});

test('intent.scene carries no forbidden retail fields', async () => {
  const { conversation } = build();
  const session = await conversation.startSession({});
  const res = await conversation.handleMessage(session.id, {
    text: 'beach day at Port Dickson, budget RM250',
  });
  const scene = res.intent.scene;
  const seen = new Set();
  const walk = (obj) => {
    if (!obj || typeof obj !== 'object') return;
    for (const [key, value] of Object.entries(obj)) {
      seen.add(key.toLowerCase());
      if (value && typeof value === 'object') walk(value);
    }
  };
  walk(scene);
  for (const forbidden of FORBIDDEN_RETAIL_FIELDS) {
    assert.ok(
      !seen.has(forbidden.toLowerCase()),
      `scene must not contain retail fact field "${forbidden}"`
    );
  }
});

test('sceneSvg(beach) returns valid inline SVG markup', () => {
  const svg = sceneSvg('beach');
  assert.ok(typeof svg === 'string' && svg.length > 0);
  assert.strictEqual(svg.trim().charAt(0), '<');
  assert.ok(svg.includes('<svg'));
});

test('sceneSvg(unknown) falls back to the studio scene markup', () => {
  const fallback = sceneSvg('does-not-exist');
  const studio = sceneSvg('studio');
  assert.ok(typeof fallback === 'string' && fallback.length > 0);
  assert.ok(fallback.includes('<svg'));
  assert.strictEqual(fallback, studio, 'unknown ids render the studio scene');
});
