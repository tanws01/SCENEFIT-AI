'use strict';

/**
 * Firebase Auth / Google Identity Platform adapter.
 *
 * Mock mode verifies deterministic demo tokens of the form "<role>:<uid>" (and
 * a few named demo tokens) and returns {uid, role}. Live mode is a TODO stub
 * that lazily requires the Firebase Admin SDK.
 */

const VALID_ROLES = Object.freeze(['shopper', 'associate', 'merchandiser', 'ops', 'admin']);

/** Named demo tokens for the hackathon walkthrough. */
const DEMO_TOKENS = Object.freeze({
  'demo-shopper': { uid: 'u-shopper-001', role: 'shopper' },
  'demo-associate': { uid: 'u-associate-001', role: 'associate' },
  'demo-merchandiser': { uid: 'u-merch-001', role: 'merchandiser' },
  'demo-ops': { uid: 'u-ops-001', role: 'ops' },
});

/**
 * @param {{mode?: 'mock'|'live', config?: object}} [opts]
 */
function createFirebaseAuth(opts = {}) {
  const mode = opts.mode === 'live' ? 'live' : 'mock';

  if (mode === 'live') {
    return {
      mode,
      async verifyToken() {
        // TODO(live): Verify a Firebase ID token via the Firebase Admin SDK /
        //   Google Identity Platform.
        //   Env vars: GOOGLE_CLOUD_PROJECT, FIREBASE_PROJECT.
        //   Lazy require: const admin = require('firebase-admin');
        //     admin.auth().verifyIdToken(token) -> decoded claims {uid, role, ...}
        throw new Error(
          'firebaseAuth live mode not implemented in MVP. ' +
          'Configure AUTH_MODE=live with Firebase Admin credentials.'
        );
      },
    };
  }

  return {
    mode,
    /**
     * @param {string} token
     * @returns {Promise<{uid:string, role:string, source:string}>}
     */
    async verifyToken(token) {
      const raw = String(token || '').replace(/^Bearer\s+/i, '').trim();

      if (DEMO_TOKENS[raw]) {
        return { ...DEMO_TOKENS[raw], source: 'auth-mock' };
      }

      // Accept "<role>:<uid>" demo tokens.
      const parts = raw.split(':');
      if (parts.length === 2 && VALID_ROLES.includes(parts[0])) {
        return { uid: parts[1], role: parts[0], source: 'auth-mock' };
      }

      const err = new Error('auth-mock: invalid or unrecognised token');
      err.code = 'UNAUTHENTICATED';
      throw err;
    },
  };
}

module.exports = { createFirebaseAuth, VALID_ROLES, DEMO_TOKENS };
