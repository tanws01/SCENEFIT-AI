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
 * Build the configuration object from the current process environment.
 * @param {NodeJS.ProcessEnv} [env=process.env]
 */
function loadConfig(env = process.env) {
  return Object.freeze({
    port: Number(env.PORT) || 8080,

    // Per-service adapter modes.
    modes: Object.freeze({
      gemini: resolveMode(env.GEMINI_MODE),
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
        model: env.GEMINI_MODEL || 'gemini-1.5-flash',
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

module.exports = { loadConfig, resolveMode, VALID_MODES };
