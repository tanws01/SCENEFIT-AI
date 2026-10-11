'use strict';

/**
 * Vertex AI image generation adapter (virtual try-on demo).
 *
 * Produces a composite preview image reference for a shopper photo + a set of
 * SKUs. The output is a VISUALISATION ONLY and is explicitly flagged as a
 * composite/approximation - it is not an authoritative statement about fit,
 * colour accuracy, or availability (those remain application-owned facts).
 *
 * Mock mode is deterministic and returns a local asset reference. Live mode is
 * a TODO stub that lazily requires the Google SDK.
 */

const DISCLAIMER =
  'Generated composite preview for illustration only. Actual fit, colour, and ' +
  'availability are confirmed by SCENEFIT in-store.';

/**
 * @param {{mode?: 'mock'|'live', config?: object}} [opts]
 */
function createVertexImage(opts = {}) {
  const mode = opts.mode === 'live' ? 'live' : 'mock';
  const config = opts.config || {};

  if (mode === 'live') {
    return {
      mode,
      async generateTryOn(/* { userPhotoRef, skus } */) {
        // TODO(live): Call Google Vertex AI image generation / virtual try-on.
        //   Endpoint: {VERTEX_LOCATION}-aiplatform.googleapis.com
        //             /v1/projects/{project}/locations/{location}/publishers/google
        //             /models/{VERTEX_IMAGE_MODEL}:predict
        //   Env vars: GOOGLE_CLOUD_PROJECT, VERTEX_LOCATION, VERTEX_IMAGE_MODEL.
        //   Lazy require: const aiplatform = require('@google-cloud/aiplatform');
        throw new Error(
          'vertexImage live mode not implemented in MVP. ' +
          'Configure VERTEX_IMAGE_MODE=live with Google Vertex AI credentials.'
        );
      },
    };
  }

  return {
    mode,
    /**
     * @param {{userPhotoRef?: string, skus?: string[]}} input
     * @returns {Promise<{imageRef:string, isComposite:boolean, disclaimer:string, skus:string[], source:string}>}
     */
    async generateTryOn(input = {}) {
      const skus = Array.isArray(input.skus) ? input.skus.slice() : [];
      // Deterministic ref derived from the inputs - no randomness.
      const key = [input.userPhotoRef || 'default-model', ...skus].join('__');
      const safeKey = key.replace(/[^a-z0-9_-]/gi, '-').toLowerCase();
      return {
        imageRef: `gs://${(config.google && config.google.storage && config.google.storage.bucket) || 'scenefit-demo-assets'}/tryon/${safeKey}.png`,
        localRef: `/assets/tryon/${safeKey}.png`,
        isComposite: true,
        disclaimer: DISCLAIMER,
        skus,
        source: 'vertex-image-mock',
      };
    },
  };
}

module.exports = { createVertexImage, DISCLAIMER };
