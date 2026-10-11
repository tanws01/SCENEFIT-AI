'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { loadConfig } = require('../src/config');
const { createAdapters } = require('../src/adapters');
const { createConversation } = require('../src/services/conversation');

function build() {
  const adapters = createAdapters(loadConfig({}));
  const conversation = createConversation({
    gemini: adapters.gemini,
    speech: adapters.speech,
    firestore: adapters.firestore,
  });
  return { adapters, conversation };
}

const PORT_DICKSON =
  'I have a beach getaway in Port Dickson this weekend with dinner and walking, '
  + 'my budget is RM250, I like linen and neutral colours, size M';
const LATEST =
  "Show me what's new, I'm into relaxed tailoring and streetwear, keep it under RM300, size L";

test('parses the Port Dickson occasion utterance (occasion entry point, budget captured)', async () => {
  const { conversation } = build();
  const session = await conversation.startSession({});
  const res = await conversation.handleMessage(session.id, { text: PORT_DICKSON });
  assert.strictEqual(res.intent.entryPoint, 'style-my-moment');
  assert.strictEqual(res.intent.wantsLatestCollection, false);
  assert.strictEqual(res.intent.budget.amountRm, 250);
  assert.ok(res.intent.occasions.includes('beach'));
  assert.strictEqual(res.followUp, null, 'no follow-up needed - direction + budget present');
});

test('parses the latest-arrivals utterance (explore-whats-new, styles captured)', async () => {
  const { conversation } = build();
  const session = await conversation.startSession({});
  const res = await conversation.handleMessage(session.id, { text: LATEST });
  assert.strictEqual(res.intent.entryPoint, 'explore-whats-new');
  assert.strictEqual(res.intent.wantsLatestCollection, true);
  assert.ok(res.intent.styles.includes('relaxed-tailoring'));
  assert.ok(res.intent.styles.includes('streetwear'));
  assert.strictEqual(res.intent.budget.amountRm, 300);
});

test('voice input is transcribed via the speech adapter and parsed', async () => {
  const { conversation } = build();
  const session = await conversation.startSession({});
  const res = await conversation.handleMessage(session.id, { voiceRef: 'demo/port-dickson.wav' });
  assert.strictEqual(res.inputMode, 'voice');
  assert.ok(res.transcript && /port dickson/i.test(res.transcript.transcript));
  assert.strictEqual(res.intent.budget.amountRm, 250);
});

test('refinement preserves the original budget when the delta does not restate it', async () => {
  const { conversation } = build();
  const session = await conversation.startSession({});
  await conversation.handleMessage(session.id, { text: PORT_DICKSON }); // budget RM250
  const refined = await conversation.handleRefine(session.id, { text: 'make it more casual, but keep the shoes' });

  assert.strictEqual(refined.intent.budget.amountRm, 250, 'mandatory budget preserved through refinement');
  assert.ok(refined.keptRoles.includes('footwear'), '"keep the shoes" recorded');
  // The "casual" signal is merged in (the mock classifies it as an occasion),
  // and the original Port Dickson context (beach) is NOT lost.
  assert.ok(refined.intent.occasions.includes('casual'), 'new casual signal merged in');
  assert.ok(refined.intent.occasions.includes('beach'), 'original trip context preserved');
});

test('refinement can change the budget when the shopper explicitly restates it', async () => {
  const { conversation } = build();
  const session = await conversation.startSession({});
  await conversation.handleMessage(session.id, { text: PORT_DICKSON }); // RM250
  const refined = await conversation.handleRefine(session.id, { text: 'actually bump my budget to RM400' });
  assert.strictEqual(refined.intent.budget.amountRm, 400);
});

test('intent switch (occasion -> latest arrivals) works mid-conversation', async () => {
  const { conversation } = build();
  const session = await conversation.startSession({});
  await conversation.handleMessage(session.id, { text: PORT_DICKSON });
  const refined = await conversation.handleRefine(session.id, { text: "actually, show me the latest arrivals instead" });
  assert.strictEqual(refined.intentSwitched, true);
  assert.strictEqual(refined.intent.wantsLatestCollection, true);
  assert.strictEqual(refined.intent.entryPoint, 'explore-whats-new');
  // Budget still preserved across the switch.
  assert.strictEqual(refined.intent.budget.amountRm, 250);
});

test('explicit entryPoint overrides keyword inference (explore-whats-new beats an occasion prompt)', async () => {
  const { conversation } = build();
  const session = await conversation.startSession({});
  // Occasion-sounding prompt that would normally infer style-my-moment, but the
  // shopper explicitly chose "Explore What's New" on Page 2.
  const res = await conversation.handleMessage(session.id, {
    text: 'sunset dinner at Batu Ferringhi beach, budget RM250',
    entryPoint: 'explore-whats-new',
  });
  assert.strictEqual(res.intent.entryPoint, 'explore-whats-new', 'explicit choice wins');
  assert.strictEqual(res.intent.wantsLatestCollection, true, 'latest-collection engine path is engaged');
  // The occasion parse (and scene) still ride along as context.
  assert.ok(res.intent.occasions.includes('beach'), 'occasion context preserved');
  assert.strictEqual(res.intent.budget.amountRm, 250, 'budget still captured');
});

test('explicit entryPoint overrides keyword inference (style-my-moment beats a latest-collection prompt)', async () => {
  const { conversation } = build();
  const session = await conversation.startSession({});
  const res = await conversation.handleMessage(session.id, {
    text: "show me what's new under RM300",
    entryPoint: 'style-my-moment',
  });
  assert.strictEqual(res.intent.entryPoint, 'style-my-moment', 'explicit choice wins');
  assert.strictEqual(res.intent.wantsLatestCollection, false, 'occasion engine path is engaged');
});

test('an unrecognised/absent entryPoint falls back to keyword inference', async () => {
  const { conversation } = build();
  const session = await conversation.startSession({});
  const res = await conversation.handleMessage(session.id, { text: LATEST, entryPoint: 'nonsense' });
  assert.strictEqual(res.intent.entryPoint, 'explore-whats-new', 'keyword inference retained');
  assert.strictEqual(res.intent.wantsLatestCollection, true);
});

test('asks a targeted follow-up only when a mandatory slot is missing', async () => {
  const { conversation } = build();
  const session = await conversation.startSession({});
  const res = await conversation.handleMessage(session.id, { text: 'hi there' });
  assert.ok(res.followUp, 'should ask a follow-up when no direction given');
  assert.strictEqual(res.followUp.field, 'direction');
});
