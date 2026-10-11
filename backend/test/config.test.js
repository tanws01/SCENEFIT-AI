'use strict';

/**
 * Config resolution tests - focus on the Gemini "live-if-key-present" default
 * (Task #1). These run fully offline and assert the sandbox/CI (no key, no
 * network) resolves Gemini to the deterministic offline mock so the whole test
 * suite can run with zero network access.
 */

const { test } = require('node:test');
const assert = require('node:assert');

const { loadConfig, resolveGeminiMode } = require('../src/config');

test('no env vars set: gemini resolves to mock (offline-safe default)', () => {
  const config = loadConfig({});
  assert.strictEqual(config.modes.gemini, 'mock');
});

test('GEMINI_API_KEY present + GEMINI_MODE unset: gemini defaults to live', () => {
  const config = loadConfig({ GEMINI_API_KEY: 'test-key-123' });
  assert.strictEqual(config.modes.gemini, 'live');
});

test('GEMINI_MODE=mock forces mock even when an API key is present', () => {
  const config = loadConfig({ GEMINI_MODE: 'mock', GEMINI_API_KEY: 'test-key-123' });
  assert.strictEqual(config.modes.gemini, 'mock');
});

test('GEMINI_MODE=live forces live even without an API key', () => {
  // The adapter itself fails fast on use when the key is missing; here we only
  // assert the mode resolution respects the explicit override.
  const config = loadConfig({ GEMINI_MODE: 'live' });
  assert.strictEqual(config.modes.gemini, 'live');
});

test('the "live-if-key" default is Gemini-specific; other services stay mock', () => {
  // A key is present and GEMINI_MODE is unset -> only gemini flips to live.
  const config = loadConfig({ GEMINI_API_KEY: 'test-key-123' });
  assert.strictEqual(config.modes.gemini, 'live');
  for (const service of ['vertexImage', 'speech', 'firestore', 'storage', 'bigquery', 'auth']) {
    assert.strictEqual(config.modes[service], 'mock', `${service} must stay mock-by-default`);
  }
});

test('resolveGeminiMode direct cases', () => {
  assert.strictEqual(resolveGeminiMode(undefined, undefined), 'mock');
  assert.strictEqual(resolveGeminiMode(undefined, ''), 'mock');
  assert.strictEqual(resolveGeminiMode(undefined, 'a-key'), 'live');
  assert.strictEqual(resolveGeminiMode('live', undefined), 'live');
  assert.strictEqual(resolveGeminiMode('mock', 'a-key'), 'mock');
  // Unrecognised value falls back to the key-present heuristic.
  assert.strictEqual(resolveGeminiMode('weird', 'a-key'), 'live');
  assert.strictEqual(resolveGeminiMode('weird', undefined), 'mock');
});
