'use strict';

/**
 * Google Cloud Speech-to-Text adapter (voice -> text).
 *
 * Mock mode returns a deterministic transcript keyed off the audio reference,
 * including canned transcripts for the two canonical demo utterances so the
 * voice entry point works fully offline. Live mode is a TODO stub.
 */

/** Deterministic canned transcripts for demo audio references. */
const DEMO_TRANSCRIPTS = Object.freeze({
  'demo/port-dickson.wav':
    'I have a beach getaway in Port Dickson this weekend with dinner and walking, my budget is RM250, I like linen and neutral colours, size M',
  'demo/latest-arrivals.wav':
    "Show me what's new, I'm into relaxed tailoring and streetwear, keep it under RM300, size L",
});

/**
 * @param {{mode?: 'mock'|'live', config?: object}} [opts]
 */
function createSpeechToText(opts = {}) {
  const mode = opts.mode === 'live' ? 'live' : 'mock';

  if (mode === 'live') {
    return {
      mode,
      async transcribe(/* audioRef */) {
        // TODO(live): Call Google Cloud Speech-to-Text.
        //   Endpoint: https://speech.googleapis.com/v1/speech:recognize
        //   Env vars: GOOGLE_CLOUD_PROJECT, SPEECH_LANGUAGE_CODE (e.g. en-MY).
        //   Lazy require: const speech = require('@google-cloud/speech');
        throw new Error(
          'speechToText live mode not implemented in MVP. ' +
          'Configure SPEECH_MODE=live with Google Cloud Speech-to-Text credentials.'
        );
      },
    };
  }

  return {
    mode,
    /**
     * @param {string} audioRef
     * @returns {Promise<{transcript:string, confidence:number, languageCode:string, source:string}>}
     */
    async transcribe(audioRef) {
      const ref = String(audioRef || '');
      const transcript = DEMO_TRANSCRIPTS[ref] ||
        'I am looking for a coordinated outfit for the weekend';
      return {
        transcript,
        confidence: 0.95,
        languageCode: 'en-MY',
        source: 'speech-mock',
      };
    },
  };
}

module.exports = { createSpeechToText, DEMO_TRANSCRIPTS };
