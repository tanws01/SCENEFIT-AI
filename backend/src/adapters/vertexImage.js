'use strict';

/**
 * Vertex AI image generation adapter (virtual try-on demo).
 *
 * Produces a composite preview image reference for a shopper photo + a set of
 * SKUs. The output is a VISUALISATION ONLY and is explicitly flagged as a
 * composite/approximation - it is not an authoritative statement about fit,
 * colour accuracy, or availability (those remain application-owned facts).
 *
 * Mock mode is deterministic and returns a local asset reference (served as an
 * inline SVG by static.js). Live mode calls Google Vertex AI image generation
 * over Node's built-in global `fetch` (no SDK, zero dependencies) and, on ANY
 * HTTP/transport/parse failure, falls back to the deterministic mock so the
 * try-on flow never breaks offline or during a transient error.
 *
 * GOOGLE-ONLY: the only image-generation provider targeted is Google Vertex AI
 * (https://{location}-aiplatform.googleapis.com).
 */

const DISCLAIMER =
  'Generated composite preview for illustration only. Actual fit, colour, and ' +
  'availability are confirmed by SCENEFIT in-store.';

/** Build the deterministic local/gs refs the mock (and live fallback) return. */
function deterministicRefs(input, bucket) {
  const skus = Array.isArray(input.skus) ? input.skus.slice() : [];
  const key = [input.userPhotoRef || 'default-model', ...skus].join('__');
  const safeKey = key.replace(/[^a-z0-9_-]/gi, '-').toLowerCase();
  return {
    skus,
    safeKey,
    imageRef: `gs://${bucket}/tryon/${safeKey}.png`,
    localRef: `/assets/tryon/${safeKey}.png`,
  };
}

/** Deterministic offline composite result (used by mock + live fallback). */
function mockGenerateTryOn(input, bucket, source) {
  const { skus, imageRef, localRef } = deterministicRefs(input, bucket);
  return {
    imageRef,
    localRef,
    imageDataUrl: null,
    isComposite: true,
    disclaimer: DISCLAIMER,
    skus,
    source: source || 'vertex-image-mock',
  };
}

/**
 * Call Google Vertex AI image generation `:predict` for a text prompt and
 * return the first predicted image as a base64 string. Uses the global `fetch`
 * (Node 18+) so there is no SDK dependency. Throws on any HTTP/transport/parse
 * failure so the caller can fall back to the deterministic mock.
 *
 * Authentication uses an OAuth access token (Application Default Credentials in
 * Cloud Run / GKE). In this zero-dependency MVP the token is read from the
 * environment (GOOGLE_ACCESS_TOKEN / GOOGLE_OAUTH_TOKEN); a full deployment
 * mints it from the metadata server or a service account.
 *
 * GOOGLE-ONLY: targets only https://{location}-aiplatform.googleapis.com.
 *
 * @param {{project:string, location:string, model:string, token:string, prompt:string}} args
 * @returns {Promise<string>} base64-encoded PNG bytes
 */
async function callVertexPredict({ project, location, model, token, prompt }) {
  const url =
    `https://${location}-aiplatform.googleapis.com/v1/projects/${encodeURIComponent(project)}` +
    `/locations/${encodeURIComponent(location)}/publishers/google/models/${encodeURIComponent(model)}:predict`;

  const body = {
    instances: [{ prompt }],
    parameters: { sampleCount: 1 },
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });

  if (!response || !response.ok) {
    const status = response ? response.status : 'no-response';
    throw new Error(`vertex image predict HTTP error: ${status}`);
  }

  const payload = await response.json();
  const b64 =
    payload &&
    payload.predictions &&
    payload.predictions[0] &&
    (payload.predictions[0].bytesBase64Encoded || payload.predictions[0].image);

  if (typeof b64 !== 'string' || b64.length === 0) {
    throw new Error('vertex image predict returned no image bytes');
  }
  return b64;
}

/**
 * Build the text prompt for the try-on composite. Describes the garments by
 * SKU and whether a shopper photo is supplied; it carries NO retail facts.
 */
function buildTryOnPrompt(input) {
  const skus = Array.isArray(input.skus) ? input.skus : [];
  const subject = input.userPhotoRef
    ? 'the supplied shopper photo'
    : 'a neutral fashion model (no personal photo supplied)';
  return [
    'Generate an illustrative fashion try-on composite image.',
    `Subject: ${subject}.`,
    `Garments to visualise (catalogue references only): ${skus.join(', ') || 'none'}.`,
    'Studio lighting, clean background, full-length. This is an approximation,',
    'not an accurate representation of fit, colour, or measurements.',
  ].join(' ');
}

/**
 * @param {{mode?: 'mock'|'live', config?: object}} [opts]
 */
function createVertexImage(opts = {}) {
  const mode = opts.mode === 'live' ? 'live' : 'mock';
  const config = opts.config || {};
  const bucket = (config.google && config.google.storage && config.google.storage.bucket) || 'scenefit-demo-assets';

  if (mode === 'live') {
    const project = (config.google && config.google.project) || 'scenefit-demo';
    const location = (config.google && config.google.vertexImage && config.google.vertexImage.location) || 'asia-southeast1';
    const model = (config.google && config.google.vertexImage && config.google.vertexImage.model) || 'imagegeneration';
    // OAuth access token for Vertex AI. In Cloud Run / GKE this comes from
    // Application Default Credentials; here it is read from the environment so
    // the adapter stays zero-dependency. Absent token -> falls back to mock.
    const token = process.env.GOOGLE_ACCESS_TOKEN || process.env.GOOGLE_OAUTH_TOKEN || '';

    return {
      mode,
      /**
       * @param {{userPhotoRef?: string, skus?: string[]}} input
       */
      async generateTryOn(input = {}) {
        const refs = deterministicRefs(input, bucket);
        if (!token) {
          // No credentials available (e.g. sandbox/CI): deterministic fallback.
          console.warn('[vertex-image-live] no access token; falling back to mock composite');
          return mockGenerateTryOn(input, bucket, 'vertex-image-mock');
        }
        try {
          const b64 = await callVertexPredict({
            project,
            location,
            model,
            token,
            prompt: buildTryOnPrompt(input),
          });
          return {
            imageRef: refs.imageRef,
            localRef: refs.localRef,
            // Real generated bytes as a data URL the frontend can render.
            imageDataUrl: `data:image/png;base64,${b64}`,
            isComposite: true,
            disclaimer: DISCLAIMER,
            skus: refs.skus,
            source: 'vertex-image-live',
          };
        } catch (err) {
          // Transient failure: fall back to the deterministic mock composite.
          console.warn(`[vertex-image-live] generateTryOn fell back to mock: ${err.message}`);
          return mockGenerateTryOn(input, bucket, 'vertex-image-mock');
        }
      },
    };
  }

  return {
    mode,
    /**
     * @param {{userPhotoRef?: string, skus?: string[]}} input
     * @returns {Promise<{imageRef:string, localRef:string, imageDataUrl:null, isComposite:boolean, disclaimer:string, skus:string[], source:string}>}
     */
    async generateTryOn(input = {}) {
      return mockGenerateTryOn(input, bucket, 'vertex-image-mock');
    },
  };
}

module.exports = {
  createVertexImage,
  DISCLAIMER,
  // Exported for unit tests of the live-mode request/prompt logic.
  _live: { callVertexPredict, buildTryOnPrompt },
};
