'use strict';

/**
 * Google Cloud Storage adapter (object storage).
 *
 * Mock mode keeps objects in memory and returns deterministic local/gs refs
 * and pseudo "signed" URLs (no network, no real signing). Live mode is a TODO
 * stub that lazily requires the Google Cloud Storage SDK.
 */

/**
 * @param {{mode?: 'mock'|'live', config?: object}} [opts]
 */
function createCloudStorage(opts = {}) {
  const mode = opts.mode === 'live' ? 'live' : 'mock';
  const config = opts.config || {};
  const bucket = (config.google && config.google.storage && config.google.storage.bucket) || 'scenefit-demo-assets';

  if (mode === 'live') {
    return {
      mode,
      async putObject() { return liveNotImplemented('putObject'); },
      async getSignedUrl() { return liveNotImplemented('getSignedUrl'); },
    };
  }

  /** @type {Map<string, Buffer|string>} */
  const objects = new Map();

  return {
    mode,
    bucket,
    /**
     * @param {string} key
     * @param {Buffer|string} data
     * @returns {Promise<{bucket:string, key:string, gsUri:string, source:string}>}
     */
    async putObject(key, data) {
      const safeKey = String(key).replace(/^\/+/, '');
      objects.set(safeKey, data == null ? '' : data);
      return {
        bucket,
        key: safeKey,
        gsUri: `gs://${bucket}/${safeKey}`,
        source: 'storage-mock',
      };
    },
    /**
     * Return a deterministic pseudo-signed URL for a stored (or expected) key.
     * @param {string} key
     * @param {{expiresInSeconds?: number}} [options]
     */
    async getSignedUrl(key, options = {}) {
      const safeKey = String(key).replace(/^\/+/, '');
      const expires = Number(options.expiresInSeconds) || 3600;
      // Deterministic placeholder token (NOT a real signature).
      const token = Buffer.from(`${bucket}:${safeKey}:${expires}`).toString('base64url');
      return {
        url: `https://storage.googleapis.com/${bucket}/${safeKey}?mock-signature=${token}`,
        expiresInSeconds: expires,
        source: 'storage-mock',
      };
    },
  };
}

function liveNotImplemented(method) {
  // TODO(live): Call Google Cloud Storage.
  //   Env vars: GOOGLE_CLOUD_PROJECT, GCS_BUCKET.
  //   Lazy require: const { Storage } = require('@google-cloud/storage');
  throw new Error(
    `cloudStorage live mode not implemented in MVP (method: ${method}). ` +
    'Configure STORAGE_MODE=live with Google Cloud Storage credentials.'
  );
}

module.exports = { createCloudStorage };
