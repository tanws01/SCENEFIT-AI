'use strict';

/**
 * SCENEFIT AI - customer shopping assistant (F01-F12), redesigned as a small
 * hash-based client-side router. ONE stage per screen:
 *
 *   #/              -> Page 1 role chooser (Shop / Retailer Dashboard / Fitting Room Queue)
 *   #/shop          -> intent choice (Style My Moment vs Explore What's New)
 *   #/shop/intent   -> alias of #/shop
 *   #/shop/prompt   -> voice-or-text prompt (calls startSession + sendMessage)
 *   #/shop/photo    -> photo options (camera / upload / AI-generated model)
 *   #/shop/results  -> the three coordinated looks + reachable tool sub-panels
 *   #/shop/profile  -> optional style profile (F03)
 *   #/shop/wardrobe -> optional wardrobe (F08)
 *
 * Vanilla browser JS, no framework, no CDN, no build, zero deps. Consumes the
 * backend JSON API via window.ScenefitApi (js/api.js). The AI-generated model
 * photo path is Google Vertex AI image generation (POST /api/tryon WITHOUT a
 * userPhotoRef). Camera (getUserMedia) and FileReader are browser-only APIs,
 * coded defensively with graceful fallback (never block the flow).
 */

(function () {
  const Api = window.ScenefitApi;
  const USER_ID = 'demo-shopper-001';
  const CURRENCY = 'RM';

  // Canonical lifecycle order for the fitting-room queue tracker (F11).
  const QUEUE_FLOW = ['Requested', 'Confirmed', 'Picking Items', 'Waiting for Room', 'Ready', 'In Fitting Room', 'Completed'];
  const QUEUE_EXCEPTIONS = ['UnavailableItems', 'DelayedPreparation', 'CustomerCancelled', 'NoShow', 'ExpiredTicket'];

  const state = {
    sessionId: null,
    entryPoint: 'style-my-moment',
    lastRecommendation: null,
    lastIntent: null,
    scene: { id: 'studio', label: 'Studio', place: null },
    // Photo consent choice for the shop flow:
    //   null = not chosen yet; 'ai' = no-consent AI-generated model (no userPhotoRef)
    //   otherwise a captured/uploaded data URL used as userPhotoRef.
    photoRef: null,
    photoMode: null, // 'camera' | 'upload' | 'ai'
    transcript: null,
    inputMode: null,
    followUp: null,
    wardrobe: [],
    queueTicketId: null,
    staffTaskId: null,
  };

  // Active camera stream so we can always stop tracks on capture / leave.
  let activeStream = null;

  // ---- tiny DOM helpers (ported) ----
  const $ = (sel) => document.querySelector(sel);
  const el = (tag, attrs, children) => {
    const node = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (k === 'class') node.className = v;
        else if (k === 'html') node.innerHTML = v;
        else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
        else if (v !== null && v !== undefined) node.setAttribute(k, v);
      }
    }
    for (const c of [].concat(children || [])) {
      if (c == null) continue;
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return node;
  };
  const rm = (n) => `${CURRENCY}${Number(n || 0).toFixed(2)}`;
  const app = () => $('#app');

  function clearApp() {
    const root = app();
    if (root) root.innerHTML = '';
    return root;
  }

  function titleCase(s) {
    return String(s || '').replace(/\b\w/g, (c) => c.toUpperCase());
  }

  function productImage(sku) {
    // Served locally by the backend static handler (and Firebase Hosting).
    return `/assets/products/${encodeURIComponent(sku)}.png`;
  }

  // ---- scene background (driven by parsed intent.scene) ----
  function applyScene() {
    const bg = $('#sceneBg');
    if (!bg) return;
    const id = (state.scene && state.scene.id) || 'studio';
    const inShopFlow = location.hash.indexOf('#/shop') === 0 && location.hash !== '#/';
    if (inShopFlow) {
      bg.style.backgroundImage = `url('/assets/scenes/${encodeURIComponent(id)}.svg')`;
      bg.classList.add('active');
    } else {
      bg.style.backgroundImage = '';
      bg.classList.remove('active');
    }
  }

  function sceneCaption() {
    if (state.scene && state.scene.place) {
      return el('p', { class: 'scene-caption' }, `Styling for: ${titleCase(state.scene.place)}`);
    }
    return null;
  }

  // ---- status line helper (per-screen) ----
  function statusLine(id) {
    return el('div', { id: id || 'status', class: 'spinner' });
  }
  function setStatus(msg, isError, id) {
    const s = document.getElementById(id || 'status');
    if (!s) return;
    s.textContent = msg || '';
    s.className = isError ? 'error-box' : 'spinner';
  }

  // ---- back / step affordance ----
  function stepBar(backHash, label) {
    const bar = el('div', { class: 'step-bar' });
    if (backHash) {
      bar.appendChild(el('button', {
        class: 'btn small ghost', type: 'button',
        onclick: () => { location.hash = backHash; },
      }, '\u2190 Back'));
    }
    if (label) bar.appendChild(el('span', { class: 'step-label' }, label));
    return bar;
  }

  // ---- session ----
  async function ensureSession() {
    if (state.sessionId) return state.sessionId;
    const res = await Api.startSession(USER_ID);
    state.sessionId = res.sessionId;
    return state.sessionId;
  }

  function captureConversationMeta(res) {
    state.transcript = (res.transcript && res.transcript.transcript) || null;
    state.inputMode = res.inputMode || null;
    state.followUp = (res.followUp && res.followUp.question) || null;
    state.lastRecommendation = res.recommendation || null;
    state.lastIntent = res.intent || null;
    if (res.intent && res.intent.scene) {
      state.scene = {
        id: res.intent.scene.id || 'studio',
        label: res.intent.scene.label || 'Studio',
        place: res.intent.scene.place || null,
      };
    }
  }

  // =====================================================================
  // ROUTER
  // =====================================================================
  const routes = {
    '': renderRoleChooser,
    '#/': renderRoleChooser,
    '#/shop': renderIntent,
    '#/shop/intent': renderIntent,
    '#/shop/prompt': renderPrompt,
    '#/shop/photo': renderPhoto,
    '#/shop/results': renderResults,
    '#/shop/profile': renderProfile,
    '#/shop/wardrobe': renderWardrobe,
  };

  function router() {
    // Leaving any screen: always stop a live camera stream.
    stopCamera();
    const hash = location.hash || '#/';
    const view = routes[hash] || routes['#/'];
    if (!routes[hash]) { location.hash = '#/'; return; }
    clearApp();
    applyScene();
    view();
    window.scrollTo(0, 0);
  }

  // =====================================================================
  // SCREEN 1: role chooser
  // =====================================================================
  function renderRoleChooser() {
    const root = app();
    root.appendChild(el('section', { class: 'hero-intro center' }, [
      el('h2', null, 'Welcome to SCENEFIT AI'),
      el('p', { class: 'muted' }, 'Choose how you want to begin. Your Plans. Your Trends. Your Look.'),
    ]));

    const grid = el('section', { class: 'role-grid', 'aria-label': 'Choose a role' }, [
      el('div', {
        class: 'role-card', tabindex: '0', role: 'button',
        onclick: () => { location.hash = '#/shop'; },
        onkeypress: (e) => { if (e.key === 'Enter' || e.key === ' ') location.hash = '#/shop'; },
      }, [
        el('div', { class: 'role-icon' }, '\uD83D\uDED2'),
        el('h3', null, 'Shop'),
        el('p', null, 'Style a complete look for your moment, or explore the latest collection - by voice or text.'),
        el('span', { class: 'pill' }, 'Customer'),
      ]),
      el('a', { class: 'role-card', href: '/retailer-dashboard.html' }, [
        el('div', { class: 'role-icon' }, '\uD83D\uDCCA'),
        el('h3', null, 'Retailer Dashboard'),
        el('p', null, 'Merchandising intelligence, demand signals, and planogram insights for the retailer.'),
        el('span', { class: 'pill' }, 'Retailer'),
      ]),
      el('a', { class: 'role-card', href: '/fitting-room-queue.html' }, [
        el('div', { class: 'role-icon' }, '\uD83D\uDEAA'),
        el('h3', null, 'Fitting Room Queue'),
        el('p', null, 'Track or cancel your fitting-room ticket, or manage the queue as staff - two views, one page.'),
        el('span', { class: 'pill' }, 'Customer & staff'),
      ]),
    ]);
    root.appendChild(grid);
  }

  // =====================================================================
  // SCREEN 2: shop intent (Style My Moment vs Explore What's New)
  // =====================================================================
  function renderIntent() {
    const root = app();
    root.appendChild(stepBar('#/', 'Shop'));
    root.appendChild(el('section', { class: 'screen-head center' }, [
      el('h2', null, 'How would you like to shop?'),
      el('p', { class: 'muted' }, 'Pick a starting point - we coordinate complete looks either way.'),
    ]));

    const choose = (entry) => {
      state.entryPoint = entry;
      location.hash = '#/shop/prompt';
    };

    root.appendChild(el('section', { class: 'entry-grid', 'aria-label': 'Choose how to start' }, [
      el('div', {
        class: 'entry-card', tabindex: '0', role: 'button',
        onclick: () => choose('style-my-moment'),
        onkeypress: (e) => { if (e.key === 'Enter' || e.key === ' ') choose('style-my-moment'); },
      }, [
        el('h2', null, '\u2728 Style My Moment'),
        el('p', null, 'Tell me about your occasion - a sunset dinner, a getaway, a celebration - and I will coordinate complete looks around it.'),
        el('span', { class: 'pill' }, 'Occasion-based'),
      ]),
      el('div', {
        class: 'entry-card', tabindex: '0', role: 'button',
        onclick: () => choose('explore-whats-new'),
        onkeypress: (e) => { if (e.key === 'Enter' || e.key === ' ') choose('explore-whats-new'); },
      }, [
        el('h2', null, '\uD83D\uDC8E Explore What\'s New'),
        el('p', null, 'Browse coordinated looks built from the latest collection and new arrivals, tuned to your taste and budget.'),
        el('span', { class: 'pill' }, 'Latest collection'),
      ]),
    ]));
  }

  // =====================================================================
  // SCREEN 3: prompt (voice or text)
  // =====================================================================
  function renderPrompt() {
    const root = app();
    // Reset the scene to the studio default so a prior prompt's background and
    // "Styling for: <place>" caption never leak onto a fresh prompt screen.
    state.scene = { id: 'studio', label: 'Studio', place: null };
    applyScene();
    root.appendChild(stepBar('#/shop', 'Your prompt'));
    const cap = sceneCaption();
    if (cap) root.appendChild(cap);

    const isNew = state.entryPoint === 'explore-whats-new';
    const panel = el('section', { class: 'panel' });
    panel.appendChild(el('h3', null, isNew ? 'Explore the latest arrivals' : 'Tell me about your moment'));

    const input = el('textarea', {
      id: 'messageInput',
      placeholder: isNew
        ? "e.g. Show me the latest arrivals. I'm into relaxed tailoring and streetwear, under RM300."
        : "e.g. sunset dinner at Batu Ferringhi beach, budget RM250.",
    });

    const micBtn = el('button', { class: 'btn mic', id: 'micBtn', type: 'button', title: 'Speak your request' }, '\uD83C\uDFA4 Speak');
    const sendBtn = el('button', { class: 'btn', id: 'sendBtn', type: 'button', onclick: () => submitPrompt(input.value) }, 'Send');

    panel.appendChild(el('div', { class: 'composer' }, [input, micBtn, sendBtn]));
    panel.appendChild(el('p', { class: 'hint', id: 'voiceHint' },
      'Voice input uses your browser microphone when available (Google Speech-to-Text handles the transcript) and falls back to a mock transcript automatically. You can always type instead.'));
    panel.appendChild(el('p', { class: 'transcript hidden', id: 'transcript' }));
    panel.appendChild(el('div', { class: 'followup hidden', id: 'followup' }));
    panel.appendChild(statusLine('status'));
    root.appendChild(panel);

    setupVoice(micBtn, input);
  }

  function showPromptMeta() {
    const t = $('#transcript');
    if (t) {
      if (state.transcript) {
        t.textContent = `Heard (${state.inputMode || 'text'}): "${state.transcript}"`;
        t.classList.remove('hidden');
      } else { t.classList.add('hidden'); }
    }
    const f = $('#followup');
    if (f) {
      if (state.followUp) { f.textContent = `\u2753 ${state.followUp}`; f.classList.remove('hidden'); }
      else { f.classList.add('hidden'); }
    }
  }

  async function submitPrompt(text) {
    if (!text || !text.trim()) { setStatus('Please type or speak your request first.', true); return; }
    try {
      setStatus('Styling your looks with Gemini and validating every item against the catalogue...');
      await ensureSession();
      const res = await Api.sendMessage({ sessionId: state.sessionId, userId: USER_ID, text: text.trim(), entryPoint: state.entryPoint });
      state.sessionId = res.sessionId || state.sessionId;
      captureConversationMeta(res);
      applyScene();
      showPromptMeta();
      setStatus('');
      // Reset any previous photo choice for the new prompt, then advance.
      state.photoRef = null;
      state.photoMode = null;
      location.hash = '#/shop/photo';
    } catch (e) {
      setStatus(`Could not get recommendations: ${e.message}`, true);
    }
  }

  // ---- voice input (Web Speech API when available; mock fallback) ----
  function setupVoice(micBtn, input) {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      micBtn.addEventListener('click', () => {
        const h = $('#voiceHint');
        if (h) h.textContent = 'Live microphone is unavailable here; using the Google Speech-to-Text mock transcript instead.';
        sendVoiceMock(input);
      });
      return;
    }
    let recognition;
    try { recognition = new SR(); } catch (_e) { recognition = null; }
    if (!recognition) { micBtn.addEventListener('click', () => sendVoiceMock(input)); return; }
    recognition.lang = 'en-MY';
    recognition.interimResults = false;
    micBtn.addEventListener('click', () => {
      try { micBtn.classList.add('recording'); recognition.start(); }
      catch (_e) { micBtn.classList.remove('recording'); }
    });
    recognition.onresult = (ev) => {
      const text = ev.results[0][0].transcript;
      if (input) input.value = text;
      micBtn.classList.remove('recording');
      submitPrompt(text);
    };
    recognition.onerror = () => { micBtn.classList.remove('recording'); sendVoiceMock(input); };
    recognition.onend = () => micBtn.classList.remove('recording');
  }

  // Fallback: send a voiceRef so the server-side Speech-to-Text mock transcribes it.
  async function sendVoiceMock(input) {
    try {
      setStatus('Transcribing voice with Google Speech-to-Text (mock) and styling...');
      await ensureSession();
      const res = await Api.sendMessage({ sessionId: state.sessionId, userId: USER_ID, voiceRef: 'demo-voice-port-dickson', entryPoint: state.entryPoint });
      state.sessionId = res.sessionId || state.sessionId;
      captureConversationMeta(res);
      if (input && state.transcript) input.value = state.transcript;
      applyScene();
      showPromptMeta();
      setStatus('');
      state.photoRef = null;
      state.photoMode = null;
      location.hash = '#/shop/photo';
    } catch (e) {
      setStatus(`Voice path failed, please type instead: ${e.message}`, true);
    }
  }

  // =====================================================================
  // SCREEN 4: photo options (camera / upload / AI-generated)
  // =====================================================================
  function renderPhoto() {
    const root = app();
    if (!state.lastRecommendation) {
      // No prompt yet - send the shopper back to the prompt screen.
      location.hash = '#/shop/prompt';
      return;
    }
    root.appendChild(stepBar('#/shop/prompt', 'Your photo'));
    const cap = sceneCaption();
    if (cap) root.appendChild(cap);

    root.appendChild(el('section', { class: 'screen-head center' }, [
      el('h2', null, 'How should we show your try-on?'),
      el('p', { class: 'muted' }, 'Try-on visuals are illustrative aids only - never a guarantee of fit, colour, drape, or measurements. You choose whether to use your own photo.'),
    ]));

    // Live preview region (camera) and chosen-photo confirmation.
    const preview = el('div', { class: 'photo-preview', id: 'photoPreview' });

    const cameraCard = el('div', { class: 'photo-card' }, [
      el('div', { class: 'photo-icon' }, '\uD83D\uDCF7'),
      el('h3', null, 'Open camera'),
      el('p', null, 'Snap a live photo now. You are consenting to use your own image for an illustrative try-on.'),
      el('button', { class: 'btn small', type: 'button', onclick: () => startCamera(preview) }, 'Open camera'),
    ]);

    const fileInput = el('input', {
      type: 'file', accept: 'image/*', id: 'photoUpload', class: 'hidden',
      onchange: (e) => handleUpload(e, preview),
    });
    const uploadCard = el('div', { class: 'photo-card' }, [
      el('div', { class: 'photo-icon' }, '\uD83D\uDDBC\uFE0F'),
      el('h3', null, 'Upload image'),
      el('p', null, 'Choose a photo from this device. You are consenting to use your own image for an illustrative try-on.'),
      el('button', { class: 'btn small', type: 'button', onclick: () => fileInput.click() }, 'Choose image'),
      fileInput,
    ]);

    const aiCard = el('div', { class: 'photo-card' }, [
      el('div', { class: 'photo-icon' }, '\u2728'),
      el('h3', null, 'No photo'),
      el('p', null, 'No consent to use your photo? Google Vertex AI image generation will synthesise an illustrative model for you instead.'),
      el('button', { class: 'btn small secondary', type: 'button', onclick: () => chooseAiModel() }, 'Let AI generate a model'),
    ]);

    root.appendChild(el('section', { class: 'photo-grid' }, [cameraCard, uploadCard, aiCard]));
    root.appendChild(preview);
    root.appendChild(statusLine('photoStatus'));
    root.appendChild(el('p', { class: 'hint' },
      'All image handling stays on this device until you request a try-on. The AI-generated option sends no personal photo at all.'));
  }

  function photoMsg(msg, isError) {
    setStatus(msg, isError, 'photoStatus');
  }

  // (a) camera via getUserMedia + canvas capture. Defensive: handle denied /
  //     no-camera / insecure-context by falling back to upload or AI options.
  async function startCamera(preview) {
    stopCamera();
    preview.innerHTML = '';
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      photoMsg('Live camera is not available in this browser/context. Please upload a photo or let AI generate a model.', true);
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      activeStream = stream;
      const video = el('video', { id: 'camVideo', autoplay: '', playsinline: '', muted: '' });
      video.srcObject = stream;
      try { await video.play(); } catch (_e) { /* autoplay attribute still shows frames */ }
      const captureBtn = el('button', { class: 'btn small', type: 'button', onclick: () => capturePhoto(video, preview) }, 'Capture photo');
      const cancelBtn = el('button', { class: 'btn small ghost', type: 'button', onclick: () => { stopCamera(); preview.innerHTML = ''; } }, 'Cancel camera');
      preview.appendChild(el('div', { class: 'cam-wrap' }, [
        video,
        el('div', { class: 'actions' }, [captureBtn, cancelBtn]),
      ]));
      photoMsg('');
    } catch (e) {
      const name = e && e.name ? e.name : '';
      let msg = 'Could not access the camera.';
      if (name === 'NotAllowedError' || name === 'SecurityError') msg = 'Camera permission was denied.';
      else if (name === 'NotFoundError' || name === 'OverconstrainedError') msg = 'No camera was found on this device.';
      msg += ' You can upload a photo or let AI generate a model instead.';
      photoMsg(msg, true);
    }
  }

  function capturePhoto(video, preview) {
    try {
      const w = video.videoWidth || 480;
      const h = video.videoHeight || 640;
      const canvas = el('canvas');
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(video, 0, 0, w, h);
      const dataUrl = canvas.toDataURL('image/png');
      stopCamera(); // always stop tracks right after capturing a frame
      setChosenPhoto(dataUrl, 'camera', preview);
    } catch (e) {
      photoMsg(`Capture failed: ${e.message}. Please upload a photo or let AI generate a model.`, true);
      stopCamera();
    }
  }

  // (b) upload via FileReader -> data URL
  function handleUpload(evt, preview) {
    const file = evt.target.files && evt.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setChosenPhoto(String(reader.result), 'upload', preview);
    reader.onerror = () => photoMsg('Could not read that file. Please try another image or let AI generate a model.', true);
    reader.readAsDataURL(file);
  }

  function setChosenPhoto(dataUrl, mode, preview) {
    state.photoRef = dataUrl;
    state.photoMode = mode;
    preview.innerHTML = '';
    preview.appendChild(el('div', { class: 'chosen-photo' }, [
      el('img', { src: dataUrl, alt: 'Your chosen photo' }),
      el('p', { class: 'muted' }, `Using your ${mode === 'camera' ? 'captured' : 'uploaded'} photo (stays on-device until you request a try-on).`),
      el('div', { class: 'actions' }, [
        el('button', { class: 'btn small', type: 'button', onclick: () => { location.hash = '#/shop/results'; } }, 'Continue to looks \u2192'),
        el('button', { class: 'btn small ghost', type: 'button', onclick: () => { state.photoRef = null; state.photoMode = null; preview.innerHTML = ''; } }, 'Choose a different photo'),
      ]),
    ]));
    photoMsg('');
  }

  // (c) explicit no-consent AI-generated model path (omit userPhotoRef).
  function chooseAiModel() {
    stopCamera();
    state.photoRef = null;
    state.photoMode = 'ai';
    location.hash = '#/shop/results';
  }

  // Always stop any live camera tracks (capture / leaving the screen).
  function stopCamera() {
    if (activeStream) {
      try { activeStream.getTracks().forEach((t) => t.stop()); } catch (_e) { /* noop */ }
      activeStream = null;
    }
  }

  // =====================================================================
  // SCREEN 5: results (three looks + reachable tools)
  // =====================================================================
  function renderResults() {
    const root = app();
    if (!state.lastRecommendation) { location.hash = '#/shop/prompt'; return; }
    root.appendChild(stepBar('#/shop/photo', 'Your looks'));
    const cap = sceneCaption();
    if (cap) root.appendChild(cap);

    // Describe the active photo choice + persistent illustrative disclaimer.
    const modeLabel = state.photoMode === 'ai'
      ? 'AI-generated model (Google Vertex AI image generation - no personal photo used)'
      : state.photoMode === 'camera' ? 'your captured photo'
      : state.photoMode === 'upload' ? 'your uploaded photo'
      : 'an AI-generated model (choose a photo on the previous screen to change this)';
    root.appendChild(el('div', { class: 'notice illustrative' },
      `Try-on previews use ${modeLabel}. All try-on visuals are illustrative aids only - never a guarantee of fit, colour, drape, or measurements.`));

    root.appendChild(el('div', { class: 'results-tools actions' }, [
      el('button', { class: 'btn small ghost', type: 'button', onclick: () => { location.hash = '#/shop/prompt'; } }, 'New prompt'),
      el('button', { class: 'btn small ghost', type: 'button', onclick: () => openRefinePanel() }, 'Refine these looks'),
      el('button', { class: 'btn small ghost', type: 'button', onclick: () => { location.hash = '#/shop/profile'; } }, 'Style profile'),
      el('button', { class: 'btn small ghost', type: 'button', onclick: () => { location.hash = '#/shop/wardrobe'; } }, 'My wardrobe'),
      el('button', { class: 'btn small ghost', type: 'button', onclick: () => openCartPanel() }, 'View cart'),
    ]));

    root.appendChild(statusLine('status'));
    root.appendChild(el('section', { id: 'results' }));
    root.appendChild(el('section', { id: 'toolPanels' }));

    renderRecommendation(state.lastRecommendation, state.lastIntent);
  }

  function openRefinePanel() {
    const panel = toolPanel('Refine or switch', []);
    const input = el('textarea', {
      placeholder: 'Refine: "Make it more casual, but keep the shoes." or switch: "Actually, show me the latest arrivals."',
    });
    panel.appendChild(el('div', { class: 'composer' }, [
      input,
      el('button', { class: 'btn secondary', type: 'button', onclick: () => refine(input.value, panel) }, 'Refine'),
    ]));
    panel.appendChild(el('p', { class: 'hint' }, 'Refinement keeps your original constraints (like budget) unless you change them, and you can switch intent mid-conversation.'));
    input.focus();
    return panel;
  }

  async function refine(text, panel) {
    if (!state.sessionId) { setStatus('Start a prompt first.', true); return; }
    if (!text || !text.trim()) { setStatus('Type a refinement, e.g. "make it more casual, keep the shoes".', true); return; }
    try {
      setStatus('Refining your look...');
      const res = await Api.refine({ sessionId: state.sessionId, userId: USER_ID, text: text.trim() });
      captureConversationMeta(res);
      applyScene();
      renderRecommendation(res.recommendation, res.intent);
      if (res.intentSwitched) setStatus('Switched intent and re-styled your looks.');
      else setStatus('');
      if (panel) panel.remove();
    } catch (e) {
      setStatus(`Could not refine: ${e.message}`, true);
    }
  }

  function refineFocus(text) {
    const panel = openRefinePanel();
    const ta = panel && panel.querySelector('textarea');
    if (ta) { ta.value = text; ta.focus(); }
  }

  // ---- render recommendations (ported) ----
  function renderRecommendation(rec, intent) {
    const results = $('#results');
    if (!results) return;
    results.innerHTML = '';
    if (!rec) return;

    if (rec.status === 'insufficient') {
      results.appendChild(renderInsufficient(rec));
      if (Array.isArray(rec.outfits) && rec.outfits.length) {
        const grid = el('div', { class: 'outfits' });
        rec.outfits.forEach((o) => grid.appendChild(renderOutfitCard(o)));
        results.appendChild(grid);
      }
      state.lastRecommendation = rec;
      return;
    }

    const header = el('div', { class: 'panel' }, [
      el('h3', null, `Three coordinated looks${rec.budget ? ` within ${rm(rec.budget.amountRm)}` : ''}`),
      el('p', { class: 'muted' }, intent && intent.wantsLatestCollection
        ? 'Built from the latest arrivals and tuned to your taste.'
        : 'Coordinated around your occasion. Every price, size, and stock figure is validated against the live catalogue.'),
    ]);
    results.appendChild(header);

    const grid = el('div', { class: 'outfits' });
    (rec.outfits || []).forEach((o) => grid.appendChild(renderOutfitCard(o)));
    results.appendChild(grid);
    state.lastRecommendation = rec;
  }

  function renderInsufficient(rec) {
    const box = el('div', { class: 'panel' });
    box.appendChild(el('div', { class: 'notice danger' }, rec.message
      || 'We could not build three complete outfits. Here are real catalogue pieces to start from - we never suggest items we do not stock.'));
    box.appendChild(el('p', { class: 'muted' }, `Formed ${rec.formed || 0} of 3 complete looks.`
      + (rec.minCompleteOutfitRm != null ? ` Most affordable complete outfit: ${rm(rec.minCompleteOutfitRm)}.` : '')));
    if (Array.isArray(rec.alternatives) && rec.alternatives.length) {
      box.appendChild(el('h4', null, 'Available alternatives'));
      const grid = el('div', { class: 'alt-grid' });
      rec.alternatives.forEach((a) => {
        grid.appendChild(el('div', { class: 'alt-card' }, [
          el('img', { src: productImage(a.sku), alt: a.name, style: 'width:100%;aspect-ratio:3/4;object-fit:cover;border-radius:8px;', onerror: imgFallback }),
          el('div', null, [el('strong', null, a.name)]),
          el('div', { class: 'muted' }, `${a.role} \u00b7 ${a.colour} \u00b7 ${rm(a.priceRm)}`),
          el('div', { class: 'muted' }, `Sizes: ${(a.availableSizes || []).join(', ') || 'n/a'}`),
        ]));
      });
      box.appendChild(grid);
    }
    return box;
  }

  function imgFallback(evt) {
    const img = evt.target;
    if (img.dataset.fallback) return;
    img.dataset.fallback = '1';
    img.src = '/assets/products/_placeholder.png';
  }

  function renderOutfitCard(o) {
    const heroSkus = (o.items || []).slice(0, 3);
    const hero = el('div', { class: 'hero' }, heroSkus.map((it) =>
      el('img', { src: productImage(it.sku), alt: it.name, loading: 'lazy', onerror: imgFallback })));

    const items = el('ul', { class: 'item-list' }, (o.items || []).map((it) =>
      el('li', null, [
        el('span', null, [
          el('span', { class: 'role-tag' }, it.role || it.category),
          document.createTextNode(it.name),
          el('div', { class: 'meta' }, `SKU ${it.sku} \u00b7 ${it.colour} \u00b7 size ${it.size} \u00b7 sizes: ${(it.availableSizes || []).join('/')}`),
        ]),
        el('span', { class: 'price' }, rm(it.priceRm)),
      ])));

    const totalRow = el('div', { class: 'total-row' }, [
      el('span', null, 'Total outfit cost'),
      el('span', { class: 'price' }, rm(o.totalPriceRm)),
    ]);

    const badges = el('div', null, [
      el('span', { class: 'badge ok' }, o.availability === 'in_stock' ? 'In stock' : (o.availability || 'available')),
      document.createTextNode(' '),
      o.budgetCompliant ? el('span', { class: 'badge budget' }, 'Within budget') : null,
    ]);

    const rationale = el('p', { class: 'rationale' }, [
      document.createTextNode(o.rationale || ''),
      el('span', { class: 'src' }, ` (${o.rationaleSource || 'styling suggestion'})`),
    ]);

    const fit = o.fitNote ? el('p', { class: 'fit-note' }, `Fit note: ${o.fitNote}`) : null;

    const actions = el('div', { class: 'actions' }, [
      actionBtn('Try on', () => openTryOn(o)),
      actionBtn('Compare', () => openCompare(o)),
      actionBtn('Swap', () => refineFocus(`Swap a piece in "${o.name}" for something different.`)),
      actionBtn('Save', () => saveOutfit(o)),
      actionBtn('Size guide', () => openSizeGuidance(o)),
      actionBtn('Find in store', () => openStoreLocation(o)),
      actionBtn('Try this physically', () => tryThisPhysically(o), 'secondary'),
      actionBtn('Request fitting room', () => requestQueue(o)),
      actionBtn('Add to cart & shop', () => addOutfitToCart(o), 'secondary'),
    ]);

    return el('div', { class: 'outfit-card' }, [
      hero,
      el('div', { class: 'body' }, [
        el('div', { class: 'theme' }, o.theme || 'look'),
        el('h4', null, o.name || 'Coordinated look'),
        badges,
        items,
        totalRow,
        rationale,
        fit,
        actions,
      ]),
    ]);
  }

  function actionBtn(label, handler, variant) {
    return el('button', { class: `btn small ${variant || 'ghost'}`, type: 'button', onclick: handler }, label);
  }

  // ---- tool panels (ported) ----
  function toolPanel(title, bodyNodes) {
    const container = $('#toolPanels');
    const panel = el('div', { class: 'panel' }, [
      el('div', { style: 'display:flex;justify-content:space-between;align-items:center;' }, [
        el('h3', null, title),
        el('button', { class: 'btn small ghost', type: 'button', onclick: () => panel.remove() }, 'Close'),
      ]),
    ].concat(bodyNodes || []));
    container.prepend(panel);
    panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    return panel;
  }

  // F05 virtual try-on - uses the shopper's photo choice (userPhotoRef) or
  // omits it entirely for the Google Vertex AI image-generation model path.
  async function openTryOn(o) {
    const panel = toolPanel(`Virtual try-on \u00b7 ${o.name}`, [el('p', { class: 'spinner' }, 'Generating illustrative preview with Google Vertex AI...')]);
    try {
      const payload = { skus: o.skus || (o.items || []).map((i) => i.sku) };
      if (state.photoMode !== 'ai' && state.photoRef) payload.userPhotoRef = state.photoRef;
      const res = await Api.tryOn(payload);
      const sp = panel.querySelector('.spinner');
      if (sp) sp.remove();
      panel.appendChild(el('div', { class: 'notice illustrative' },
        res.compositeLabel || res.disclaimer
        || 'Illustrative composite preview only - not a guarantee of fit, colour, drape, or measurements.'));
      const live = res.source === 'vertex-image-live' && res.imageDataUrl;
      panel.appendChild(el('div', { class: 'tryon-preview' }, [
        el('div', { class: 'tryon-frame' }, [
          // Prefer the real Google Vertex AI generation when present; otherwise
          // fall back to the deterministic offline swatch (no network).
          tryOnVisual(res, o),
          el('p', { class: 'muted' }, (live ? 'Live Google Vertex AI generation \u00b7 ' : 'Illustrative aid \u00b7 ')
            + ((res.skus || []).join(', '))),
          el('p', { class: 'muted' }, state.photoMode === 'ai' || !state.photoRef
            ? 'Model synthesised by Google Vertex AI image generation (no personal photo used).'
            : 'Composed over your supplied photo.'),
        ]),
      ]));
      panel.appendChild(el('p', { class: 'hint' }, 'Compare looks or switch garments/colours. This visual never guarantees fit.'));
    } catch (e) {
      panel.appendChild(el('div', { class: 'error-box' }, `Try-on failed: ${e.message}`));
    }
  }

  function openCompare(o) {
    const rec = state.lastRecommendation;
    const others = (rec && rec.outfits || []).filter((x) => x.id !== o.id);
    const other = others[0];
    const panel = toolPanel('Compare looks', []);
    panel.appendChild(el('div', { class: 'notice illustrative' }, 'Side-by-side comparison. Composite visuals are illustrative aids only.'));
    const grid = el('div', { class: 'tryon-preview', style: 'grid-template-columns:1fr 1fr;' }, [
      el('div', { class: 'tryon-frame' }, [svgPreviewFor(o), el('p', { class: 'muted' }, `${o.name} \u00b7 ${rm(o.totalPriceRm)}`)]),
      other ? el('div', { class: 'tryon-frame' }, [svgPreviewFor(other), el('p', { class: 'muted' }, `${other.name} \u00b7 ${rm(other.totalPriceRm)}`)]) : el('div', { class: 'muted' }, 'No second look to compare.'),
    ]);
    panel.appendChild(grid);
  }

  // Render the try-on visual: the real Google Vertex AI generated image when
  // the backend returned live bytes (data URL), otherwise the deterministic
  // offline SVG swatch. Degrades gracefully if the image fails to load.
  function tryOnVisual(res, o) {
    if (res && res.source === 'vertex-image-live' && res.imageDataUrl) {
      const img = el('img', {
        src: res.imageDataUrl,
        alt: 'Google Vertex AI try-on generation (illustrative)',
        style: 'width:100%;max-width:240px;aspect-ratio:3/4;object-fit:cover;border-radius:8px;',
      });
      // If the generated image fails to render, swap in the offline swatch.
      img.addEventListener('error', () => {
        const fallback = svgPreviewFor(o);
        if (img.parentNode) img.parentNode.replaceChild(fallback, img);
      });
      return img;
    }
    return svgPreviewFor(o);
  }

  // Build a simple inline SVG swatch board from item colours (no network).
  function svgPreviewFor(o) {
    const colours = (o.items || []).map((i) => colourHex(i.colour));
    const w = 240, h = 300;
    const parts = colours.map((c, i) => `<rect x="${20 + i * 48}" y="40" width="40" height="${220}" rx="6" fill="${c}" stroke="#d8d2c8"/>`).join('');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="Illustrative outfit swatch">
      <rect width="${w}" height="${h}" fill="#f6f2ec"/>
      <text x="${w / 2}" y="24" text-anchor="middle" font-size="12" fill="#4a4857">Illustrative composite</text>
      ${parts}
      <text x="${w / 2}" y="${h - 14}" text-anchor="middle" font-size="11" fill="#6b4de6">${(o.name || 'Look').slice(0, 32)}</text>
    </svg>`;
    const wrap = el('div');
    wrap.innerHTML = svg;
    return wrap.firstChild;
  }

  function colourHex(name) {
    const map = {
      cream: '#efe7d6', white: '#f7f5f0', beige: '#e4d5bb', navy: '#2a3450', black: '#2a2a2e',
      olive: '#6b6b3a', grey: '#9a9aa0', brown: '#7a5a3c', khaki: '#b7a884', blue: '#4a6fa5',
    };
    return map[String(name || '').toLowerCase()] || '#c9c2b6';
  }

  // F06 size guidance with uncertainty notice
  function openSizeGuidance(o) {
    const topItem = (o.items || []).find((i) => i.category === 'top') || (o.items || [])[0];
    const panel = toolPanel(`Size guidance \u00b7 ${topItem ? topItem.name : o.name}`, []);
    const chest = el('input', { type: 'number', id: 'sgChest', placeholder: 'e.g. 99' });
    const pref = el('input', { type: 'text', id: 'sgPref', placeholder: 'e.g. M' });
    panel.appendChild(el('div', { class: 'row' }, [
      el('div', null, [el('label', null, 'Chest (cm, optional)'), chest]),
      el('div', null, [el('label', null, 'Preferred size (optional)'), pref]),
    ]));
    const out = el('div');
    panel.appendChild(el('div', { class: 'actions' }, [
      el('button', { class: 'btn small', type: 'button', onclick: run }, 'Get guidance'),
    ]));
    panel.appendChild(out);

    async function run() {
      out.innerHTML = '<p class="spinner">Checking retailer size charts...</p>';
      try {
        const res = await Api.sizeGuidance({
          sku: topItem && topItem.sku,
          category: topItem && topItem.category,
          measurements: chest.value ? { chest: Number(chest.value) } : undefined,
          preferredSize: pref.value || undefined,
        });
        out.innerHTML = '';
        out.appendChild(el('p', null, [el('strong', null, `Suggested size: ${res.suggestedSize || 'n/a'}`), document.createTextNode(` (${res.confidence})`)]));
        if (res.rationale) out.appendChild(el('p', { class: 'muted' }, res.rationale));
        if (res.alternatives && res.alternatives.length) {
          out.appendChild(el('p', { class: 'muted' }, `Alternatives: ${res.alternatives.map((a) => `${a.size} (${a.relation})`).join(', ')}`));
        }
        (res.uncertaintyNotices || []).forEach((n) => out.appendChild(el('div', { class: 'notice' }, n)));
      } catch (e) {
        out.innerHTML = `<p class="error-box">Size guidance failed: ${e.message}</p>`;
      }
    }
  }

  // F09 store location
  async function openStoreLocation(o) {
    const first = (o.items || [])[0];
    const panel = toolPanel(`Find in store \u00b7 ${o.name}`, [el('p', { class: 'spinner' }, 'Looking up rack location...')]);
    try {
      const res = await Api.locate(first.sku);
      const sp = panel.querySelector('.spinner');
      if (sp) sp.remove();
      if (!res.found) {
        panel.appendChild(el('div', { class: 'notice' }, res.message || 'Location unavailable - please ask a store associate.'));
        panel.appendChild(el('div', { class: 'actions' }, [el('button', { class: 'btn small', type: 'button', onclick: () => requestStaffAssist(o) }, 'Request staff assistance')]));
        return;
      }
      const L = res.location;
      panel.appendChild(el('p', null, [el('strong', null, res.productName || first.name)]));
      const dl = el('dl', { class: 'loc-grid' });
      [['Store', L.store], ['Floor', L.floor], ['Zone', L.zone], ['Aisle', L.aisle], ['Rack', L.rack], ['Position', L.position]].forEach(([k, v]) => {
        if (!v && v !== 0) return;
        dl.appendChild(el('dt', null, k));
        dl.appendChild(el('dd', null, String(v)));
      });
      panel.appendChild(dl);
      panel.appendChild(el('div', { class: 'notice illustrative' }, `Directions: ${res.directions}`));
      panel.appendChild(el('div', { class: 'actions' }, [el('button', { class: 'btn small', type: 'button', onclick: () => requestStaffAssist(o) }, 'Ask staff to pull these items')]));
    } catch (e) {
      const sp = panel.querySelector('.spinner');
      if (sp) sp.textContent = `Lookup failed: ${e.message}`;
    }
  }

  // F10 "Try this physically" - creates a real picking request (POST /api/staff-task)
  // that lands on the staff Fitting Room Queue board, where an associate accepts it
  // and prepares the items for a fitting room.
  async function tryThisPhysically(o) {
    try {
      setStatus('Sending picking request to store staff...');
      const res = await Api.staffTask({
        userId: USER_ID,
        garments: (o.items || []).map((i) => ({ sku: i.sku, size: i.size, colour: i.colour })),
      });
      state.staffTaskId = res.id;
      setStatus('');
      toolPanel(`Try this physically \u00b7 ${o.name || 'this look'}`, [
        el('p', null, res.customerStatus || 'Your request has been sent to a store associate who will prepare these items for a fitting room.'),
        el('p', { class: 'muted' }, 'A store associate will pick these pieces and ready a fitting room for you - watch for your request on the staff board.'),
        el('p', { class: 'muted' }, `Task ${res.id} \u00b7 status: ${res.status}`),
        el('ul', { class: 'item-list' }, (res.garments || []).map((g) =>
          el('li', null, [el('span', null, `${g.name || g.sku} \u00b7 size ${g.size || '-'} \u00b7 ${g.colour || '-'}`),
            el('span', { class: 'badge ' + (g.available ? 'ok' : 'budget') }, g.available === false ? 'check stock' : 'available')]))),
      ]);
    } catch (e) {
      setStatus(`Staff request failed: ${e.message}`, true);
    }
  }

  // Store-location affordance keeps calling the same picking-request handler.
  const requestStaffAssist = tryThisPhysically;

  // F11 fitting-room queue
  async function requestQueue(o) {
    try {
      setStatus('Requesting a fitting-room place...');
      const res = await Api.requestQueue({
        userId: USER_ID,
        items: (o.items || []).map((i) => ({ sku: i.sku, size: i.size, colour: i.colour })),
      });
      setStatus('');
      if (!res.supported) {
        toolPanel('Fitting-room queue (F11)', [el('div', { class: 'notice danger' }, res.message || 'This branch does not support fitting-room queue requests.')]);
        return;
      }
      state.queueTicketId = res.ticket.id;
      renderQueueTracker(res.ticket);
    } catch (e) {
      setStatus(`Queue request failed: ${e.message}`, true);
    }
  }

  function renderQueueTracker(ticket) {
    const existing = document.getElementById(`queue-${ticket.id}`);
    const body = [];
    body.push(el('p', null, [el('strong', null, `Ticket ${ticket.id}`), document.createTextNode(` \u00b7 ${ticket.storeName || ''}`)]));
    body.push(el('div', { class: 'notice' }, ticket.liveStatusMessage || ''));

    const isException = QUEUE_EXCEPTIONS.includes(ticket.status);
    const currentIdx = QUEUE_FLOW.indexOf(ticket.status);
    const steps = el('ul', { class: 'queue-steps' }, QUEUE_FLOW.map((s, i) => {
      let cls = '';
      if (!isException) {
        if (i < currentIdx) cls = 'done';
        else if (i === currentIdx) cls = 'current';
      } else if (i === 0) { cls = 'done'; }
      return el('li', { class: cls }, [el('span', { class: 'dot' }), document.createTextNode(s)]);
    }));
    body.push(steps);
    if (isException) {
      body.push(el('div', { class: 'notice danger' }, `Exception: ${ticket.status}`));
    }
    body.push(el('div', { class: 'actions' }, [
      el('button', { class: 'btn small', type: 'button', onclick: () => refreshQueue(ticket.id) }, 'Refresh status'),
      el('button', { class: 'btn small ghost', type: 'button', onclick: () => cancelQueue(ticket.id) }, 'Cancel (you stay in control)'),
    ]));
    body.push(el('p', { class: 'hint' }, 'Lifecycle: Requested \u2192 Confirmed \u2192 Picking Items \u2192 Waiting for Room \u2192 Ready \u2192 In Fitting Room \u2192 Completed. The store confirms your place - we never promise it before that.'));

    if (existing) {
      existing.innerHTML = '';
      body.forEach((n) => existing.appendChild(n));
    } else {
      const panel = toolPanel('Fitting-room queue (F11)', body);
      panel.id = `queue-${ticket.id}`;
    }
  }

  async function refreshQueue(id) {
    try {
      const ticket = await Api.getQueue(id);
      renderQueueTracker(ticket);
    } catch (e) { setStatus(`Could not refresh queue: ${e.message}`, true); }
  }
  async function cancelQueue(id) {
    try {
      const ticket = await Api.cancelQueue(id);
      renderQueueTracker(ticket);
    } catch (e) { setStatus(`Could not cancel: ${e.message}`, true); }
  }

  // F12 cart & checkout handoff
  async function saveOutfit(o) {
    try {
      await Api.addToCart({ userId: USER_ID, outfit: { id: o.id, name: o.name, items: o.items, totalPriceRm: o.totalPriceRm } });
      setStatus(`Saved "${o.name}" for comparison.`);
    } catch (e) { setStatus(`Save failed: ${e.message}`, true); }
  }

  async function addOutfitToCart(o) {
    try {
      setStatus('Adding items to your cart...');
      for (const it of o.items || []) {
        await Api.addToCart({ userId: USER_ID, item: { sku: it.sku, size: it.size, colour: it.colour, quantity: 1 } });
      }
      const cart = await Api.getCart(USER_ID);
      setStatus('');
      renderCart(cart);
    } catch (e) { setStatus(`Add to cart failed: ${e.message}`, true); }
  }

  async function openCartPanel() {
    try {
      const cart = await Api.getCart(USER_ID);
      renderCart(cart);
    } catch (e) { setStatus(`Could not load cart: ${e.message}`, true); }
  }

  function renderCart(payload) {
    const cart = payload.cart || payload;
    const body = [];
    body.push(el('ul', { class: 'item-list' }, (cart.items || []).map((i) =>
      el('li', null, [el('span', null, `${i.name || i.sku} \u00b7 ${i.colour || ''} \u00b7 size ${i.size || '-'} \u00d7${i.quantity}`), el('span', { class: 'price' }, i.priceRm != null ? rm(i.priceRm) : 'n/a')]))));
    const total = (cart.items || []).reduce((s, i) => s + (Number(i.priceRm) || 0) * (i.quantity || 1), 0);
    body.push(el('div', { class: 'total-row' }, [el('span', null, 'Cart total'), el('span', { class: 'price' }, rm(total))]));
    body.push(el('div', { class: 'notice' }, 'SCENEFIT never processes payment. Checkout hands off to the retailer\'s secure checkout/POS - you stay in control.'));
    const out = el('div');
    body.push(el('div', { class: 'actions' }, [
      el('button', { class: 'btn small', type: 'button', onclick: () => handoff('online') }, 'Checkout online (handoff)'),
      el('button', { class: 'btn small ghost', type: 'button', onclick: () => handoff('physical') }, 'Shop in store'),
    ]));
    body.push(out);
    toolPanel('Cart & checkout handoff (F12)', body);

    async function handoff(mode) {
      try {
        const res = await Api.checkoutHandoff({ userId: USER_ID, mode });
        out.innerHTML = '';
        out.appendChild(el('div', { class: 'notice' }, res.disclaimer));
        out.appendChild(el('p', null, res.instruction || ''));
        if (res.checkoutUrl) out.appendChild(el('p', { class: 'muted' }, `Handoff link: ${res.checkoutUrl}`));
        out.appendChild(el('p', { class: 'muted' }, `Estimated total: ${rm(res.estimatedTotalRm)} (${res.itemCount} items)`));
      } catch (e) {
        out.innerHTML = `<p class="error-box">Checkout handoff failed: ${e.message}</p>`;
      }
    }
  }

  // =====================================================================
  // OPTIONAL SCREEN: profile (F03)
  // =====================================================================
  function renderProfile() {
    const root = app();
    root.appendChild(stepBar(state.lastRecommendation ? '#/shop/results' : '#/shop', 'Style profile'));
    const panel = el('section', { class: 'panel' });
    panel.appendChild(el('h3', null, '\u2699 Style & preference profile (optional, F03)'));
    const sizeTop = el('select', { id: 'pfSizeTop' });
    ['', 'XS', 'S', 'M', 'L', 'XL'].forEach((v) => sizeTop.appendChild(el('option', { value: v }, v || '-')));
    const sizeShoe = el('select', { id: 'pfSizeShoe' });
    ['', '40', '41', '42', '43'].forEach((v) => sizeShoe.appendChild(el('option', { value: v }, v || '-')));
    panel.appendChild(el('div', { class: 'row' }, [
      el('div', null, [el('label', null, 'Top size'), sizeTop]),
      el('div', null, [el('label', null, 'Shoe size (EU)'), sizeShoe]),
    ]));
    const styles = el('input', { type: 'text', id: 'pfStyles', placeholder: 'relaxed-tailoring, streetwear, minimalist' });
    const colours = el('input', { type: 'text', id: 'pfColours', placeholder: 'navy, olive, cream' });
    const avoid = el('input', { type: 'text', id: 'pfAvoid', placeholder: 'orange' });
    panel.appendChild(el('label', null, 'Preferred styles (comma separated)'));
    panel.appendChild(styles);
    panel.appendChild(el('label', null, 'Preferred colours'));
    panel.appendChild(colours);
    panel.appendChild(el('label', null, 'Colours to avoid'));
    panel.appendChild(avoid);
    const status = el('p', { class: 'hint', id: 'profileStatus' });
    panel.appendChild(el('div', { class: 'actions' }, [
      el('button', { class: 'btn small', type: 'button', onclick: () => saveProfile(status) }, 'Save profile'),
    ]));
    panel.appendChild(status);
    root.appendChild(panel);
  }

  async function saveProfile(status) {
    const splitList = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
    try {
      const profile = {
        sizes: { top: $('#pfSizeTop').value || undefined, footwear: $('#pfSizeShoe').value || undefined },
        preferredStyles: splitList($('#pfStyles').value),
        preferredColours: splitList($('#pfColours').value),
        avoidedColours: splitList($('#pfAvoid').value),
      };
      await Api.putProfile(USER_ID, profile);
      if (status) status.textContent = 'Profile saved. Future looks will use these preferences.';
    } catch (e) {
      if (status) status.textContent = `Could not save profile: ${e.message}`;
    }
  }

  // =====================================================================
  // OPTIONAL SCREEN: wardrobe (F08)
  // =====================================================================
  function renderWardrobe() {
    const root = app();
    root.appendChild(stepBar(state.lastRecommendation ? '#/shop/results' : '#/shop', 'My wardrobe'));
    const panel = el('section', { class: 'panel' });
    panel.appendChild(el('h3', null, '\uD83D\uDC54 My wardrobe (optional, F08)'));
    panel.appendChild(el('p', { class: 'muted' }, 'Add pieces you already own so looks can be built around them. Owned-item cost is shown separately from purchase cost.'));
    const input = el('input', { type: 'text', id: 'wardrobeInput', placeholder: 'e.g. white sneakers, navy cap' });
    const list = el('ul', { class: 'item-list', id: 'wardrobeList' });
    panel.appendChild(el('div', { class: 'composer' }, [
      input,
      el('button', { class: 'btn small', type: 'button', onclick: () => { addWardrobeItem(input); renderWardrobeList(list); } }, 'Add owned item'),
    ]));
    panel.appendChild(list);
    root.appendChild(panel);
    renderWardrobeList(list);
  }

  function addWardrobeItem(input) {
    const v = (input.value || '').trim();
    if (!v) return;
    state.wardrobe.push(v);
    input.value = '';
  }
  function renderWardrobeList(list) {
    list.innerHTML = '';
    state.wardrobe.forEach((w, idx) => {
      list.appendChild(el('li', null, [
        el('span', null, `${w} `),
        el('span', { class: 'muted' }, '(owned - RM0.00 purchase cost)'),
        el('button', { class: 'btn small ghost', type: 'button', style: 'margin-left:auto;', onclick: () => { state.wardrobe.splice(idx, 1); renderWardrobeList(list); } }, 'Remove'),
      ]));
    });
  }

  // =====================================================================
  // BOOT
  // =====================================================================
  window.addEventListener('hashchange', router);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', router);
  else router();
})();
