'use strict';

/**
 * SCENEFIT AI runtime configuration.
 *
 * Reads environment variables and selects the adapter mode for each Google
 * Cloud service. Everything defaults to deterministic offline "mock" mode so
 * the application runs with zero network access. A service is switched to
 * "live" only in a deployed Google Cloud environment.
 *
 * GOOGLE-ONLY: the only cloud/AI providers this project ever targets are
 * Google (Gemini, Vertex AI, Cloud Speech-to-Text, Cloud Run, Firebase
 * Hosting, Firestore, Cloud Storage, BigQuery, Firebase Auth, Secret Manager).
 */

const VALID_MODES = Object.freeze(['mock', 'live']);

/**
 * Resolve an adapter mode from an env var, defaulting to "mock".
 * Any value other than "live" (case-insensitive) resolves to "mock" so the
 * app can never accidentally attempt a network call offline.
 * @param {string|undefined} value
 * @returns {'mock'|'live'}
 */
function resolveMode(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === 'live' ? 'live' : 'mock';
}

/**
 * Resolve the Gemini adapter mode with a "live-if-key-present" default.
 *
 * Gemini is the one service with a fully offline-safe live path: the live
 * adapter uses Node's built-in global `fetch` (no SDK) and ALWAYS falls back to
 * the deterministic mock on any HTTP/transport/parse failure. That makes it
 * safe to default to LIVE whenever a key is available, so the "thinking" parts
 * (intent, outfit concepts, explanations, retail analysis) are AI-driven out of
 * the box, while the app still runs fully offline with no key.
 *
 * Resolution rules (explicit GEMINI_MODE always wins):
 *   - GEMINI_MODE=live  -> 'live'  (force live; adapter fails fast if no key)
 *   - GEMINI_MODE=mock  -> 'mock'  (force offline, even if a key is present)
 *   - GEMINI_MODE unset -> 'live' when GEMINI_API_KEY is set, else 'mock'
 *
 * This "key-present" default is Gemini-specific. The other Google services
 * (Vertex image / speech / firestore / storage / bigquery / auth) keep the
 * plain mock-by-default via resolveMode(): they have different live-safety
 * characteristics and are opted in explicitly per deployment.
 *
 * @param {string|undefined} modeValue  value of GEMINI_MODE
 * @param {string|undefined} apiKeyValue value of GEMINI_API_KEY
 * @returns {'mock'|'live'}
 */
function resolveGeminiMode(modeValue, apiKeyValue) {
  const normalized = String(modeValue || '').trim().toLowerCase();
  if (normalized === 'live') return 'live';
  if (normalized === 'mock') return 'mock';
  // Unset / unrecognised: default to live only when an API key is available so
  // the sandbox/CI (no key, no network) still resolves to the offline mock.
  const hasKey = String(apiKeyValue || '').trim().length > 0;
  return hasKey ? 'live' : 'mock';
}

/**
 * Build the configuration object from the current process environment.
 * @param {NodeJS.ProcessEnv} [env=process.env]
 */
function loadConfig(env = process.env) {
  return Object.freeze({
    port: Number(env.PORT) || 8080,

    // Per-service adapter modes.
    modes: Object.freeze({
      // Gemini defaults to LIVE when GEMINI_API_KEY is present (offline-safe:
      // the live adapter falls back to the deterministic mock on any failure);
      // otherwise it stays on the offline mock. GEMINI_MODE always overrides.
      gemini: resolveGeminiMode(env.GEMINI_MODE, env.GEMINI_API_KEY),
      vertexImage: resolveMode(env.VERTEX_IMAGE_MODE),
      speech: resolveMode(env.SPEECH_MODE),
      firestore: resolveMode(env.FIRESTORE_MODE),
      storage: resolveMode(env.STORAGE_MODE),
      bigquery: resolveMode(env.BIGQUERY_MODE),
      auth: resolveMode(env.AUTH_MODE),
    }),

    // Google Cloud platform settings.
    google: Object.freeze({
      project: env.GOOGLE_CLOUD_PROJECT || 'scenefit-demo',
      firebaseProject: env.FIREBASE_PROJECT || 'scenefit-demo',

      gemini: Object.freeze({
        apiKey: env.GEMINI_API_KEY || '',
        // Default to a current, widely-available GA model. Override with
        // GEMINI_MODEL to use the newest available id (discover via the
        // models-list endpoint; see README).
        model: env.GEMINI_MODEL || 'gemini-2.5-flash',
      }),

      vertexImage: Object.freeze({
        location: env.VERTEX_LOCATION || 'asia-southeast1',
        model: env.VERTEX_IMAGE_MODEL || 'imagegeneration',
      }),

      speech: Object.freeze({
        languageCode: env.SPEECH_LANGUAGE_CODE || 'en-MY',
      }),

      storage: Object.freeze({
        bucket: env.GCS_BUCKET || 'scenefit-demo-assets',
      }),

      bigquery: Object.freeze({
        dataset: env.BIGQUERY_DATASET || 'scenefit_analytics',
      }),
    }),

    // Currency used across the catalogue and all pricing.
    currency: 'RM',
  });
}

module.exports = { loadConfig, resolveMode, resolveGeminiMode, VALID_MODES };
