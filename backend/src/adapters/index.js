'use strict';

/**
 * Adapter registry. Builds every Google service adapter from the resolved
 * config, selecting mock (offline, default) or live mode per service.
 *
 * GOOGLE-ONLY: every adapter here fronts a Google Cloud service.
 */

const { createGemini } = require('./gemini');
const { createVertexImage } = require('./vertexImage');
const { createSpeechToText } = require('./speechToText');
const { createFirestore } = require('./firestore');
const { createCloudStorage } = require('./cloudStorage');
const { createBigQuery } = require('./bigquery');
const { createFirebaseAuth } = require('./firebaseAuth');

/**
 * @param {object} config result of config.loadConfig()
 */
function createAdapters(config) {
  const modes = (config && config.modes) || {};
  return {
    gemini: createGemini({ mode: modes.gemini, config }),
    vertexImage: createVertexImage({ mode: modes.vertexImage, config }),
    speech: createSpeechToText({ mode: modes.speech, config }),
    firestore: createFirestore({ mode: modes.firestore, config }),
    storage: createCloudStorage({ mode: modes.storage, config }),
    bigquery: createBigQuery({ mode: modes.bigquery, config }),
    auth: createFirebaseAuth({ mode: modes.auth, config }),
  };
}

module.exports = {
  createAdapters,
  createGemini,
  createVertexImage,
  createSpeechToText,
  createFirestore,
  createCloudStorage,
  createBigQuery,
  createFirebaseAuth,
};
