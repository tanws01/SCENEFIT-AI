# SCENEFIT AI

**Your Plans. Your Trends. Your Look.**

A **Google-only** voice-first, multimodal fashion shopping assistant and
retailer intelligence platform (MVP). SCENEFIT AI turns a shopper's described
moment (an occasion or "what's new") into exactly three coordinated, budget- and
SKU-validated outfit recommendations, with virtual try-on, size guidance,
in-store rack navigation, staff-assisted collection, a smart fitting-room queue,
and retailer / staff / merchandising dashboards.

Prices are in **RM** (Malaysian Ringgit).

## Table of contents

1. [Product overview](#product-overview)
2. [Screens and navigation](#screens-and-navigation)
3. [Google-only architecture](#google-only-architecture)
4. [The suggest / validate principle](#the-suggest--validate-principle)
5. [Run the full stack offline (mocks)](#run-the-full-stack-offline-mocks)
6. [Run the tests](#run-the-tests)
7. [Demo scenarios](#demo-scenarios)
8. [Mock to live: env var reference](#mock-to-live-env-var-reference)
   - [Live Gemini (Google AI Studio)](#live-gemini-google-ai-studio)
9. [Deploy notes (Cloud Run + Firebase Hosting)](#deploy-notes-cloud-run--firebase-hosting)
10. [MVP scope vs future phases](#mvp-scope-vs-future-phases)
11. [Project layout](#project-layout)
12. [Google-only statement](#google-only-statement)

## Product overview

SCENEFIT AI is a mobile-first web app backed by a JSON REST API. The customer
experience is a clean, multi-screen flow (one task per screen) instead of a
single crowded page. From a Page-1 role chooser a shopper enters the Shop flow,
picks a starting point, speaks or types what they are shopping for ("sunset
dinner at Batu Ferringhi beach, stylish but comfortable, under RM250"); the
assistant understands the moment and returns three complete, coordinated looks
that are guaranteed to be within budget and composed only of real, in-stock
catalogue items. From there the shopper can preview a virtual try-on, get size
guidance, find the exact rack in store, join the fitting-room queue, request
staff-assisted collection, and hand off to checkout - each surfaced as its own
clean step rather than crammed onto one page. Retailer, staff, and
merchandising dashboards surface aggregated retail intelligence.

The entire stack runs **fully offline** with deterministic mocks for every
Google Cloud service, so the demo needs no network, no credentials, and no
third-party packages.

## Screens and navigation

The customer app (`frontend/index.html` + `frontend/js/app.js`) is a **vanilla,
no-build, client-side hash router** - a single `index.html` shell whose screens
are selected by `location.hash`. There is no framework, bundler, or build step.

**Page 1 - role chooser** (`#/`): the entry screen asks the visitor to choose
one of three roles:

- **Shop** - the customer shopping flow (stays in `index.html`).
- **Retailer Dashboard** - links to `retailer-dashboard.html`.
- **Staff** - links to `staff-dashboard.html`.

**Shop flow** (one stage per screen):

| Hash route | Screen | What happens |
| --- | --- | --- |
| `#/shop/intent` | Choose intent | Pick **Style My Moment** (occasion-based) or **Explore What's New** (latest collection). |
| `#/shop/prompt` | Give your prompt | Describe the moment **by voice or text**. Voice uses the browser microphone when available (transcribed by Google Cloud Speech-to-Text) and falls back to a mock transcript; you can always type instead. |
| `#/shop/photo` | Choose a photo option | Open camera, upload an image, or use a no-consent AI-generated model (see below). |
| `#/shop/results` | Three validated looks | The three coordinated, budget- and SKU-validated outfits, with reachable sub-steps for virtual try-on, size guidance, in-store rack location, staff-assisted collection, fitting-room queue, and cart / checkout handoff. |

(`#/` is the role chooser; `#/shop` is an alias of `#/shop/intent`. The
retailer and staff dashboards remain their own standalone `.html` pages.)

### Photo options and the explicit consent model

On the photo screen the shopper explicitly chooses how their try-on is
visualised. Try-on composites are always **illustrative aids only**:

- **Open camera** - captures a live photo via the browser `getUserMedia` Web
  API, with **explicit consent** to use your own image. If the camera is denied,
  missing, or the context is insecure, the UI **falls back gracefully** and
  invites you to upload a photo or let AI generate a model instead - the flow is
  never blocked.
- **Upload an image** - choose a photo from the device (read on-device via
  `FileReader`), again with explicit consent.
- **No-consent AI-generated model** - if you do **not** consent to using your
  own photo, **Google Vertex AI image generation** synthesises an illustrative
  model instead. This is wired through `POST /api/tryon` **without** a
  `userPhotoRef`, so **no personal photo is sent at all**.

The camera (`getUserMedia`) and `FileReader` are browser-only APIs; they are
coded defensively and are not exercised by the offline `node:test` suite.
`localhost` is a secure context, so the camera works in a manual browser demo.

### Scene backgrounds (synthesised offline)

When the prompt names a specific place (e.g. "Batu Ferringhi beach"), the parsed
intent carries a deterministic `scene` field. The Shop screens then show a
matching background served at **`/assets/scenes/<id>.svg`** (for example
`/assets/scenes/beach.svg`). Scenes are **synthesised offline as inline SVG** by
`backend/src/static.js` - exactly like the product placeholders - so there are
**no remote images and no CDN dependencies**. An unknown or absent place falls
back to a neutral `studio` scene.

## Google-only architecture

The only cloud / AI providers this project targets are Google. Each capability
maps to a dedicated Google service behind an adapter:

| Capability | Google service | Adapter / artifact |
| --- | --- | --- |
| Language understanding + styling suggestions | Gemini (Vertex AI / Generative Language API) | `backend/src/adapters/gemini.js` |
| Virtual try-on image generation | Vertex AI image generation | `backend/src/adapters/vertexImage.js` |
| Voice to text | Cloud Speech-to-Text | `backend/src/adapters/speechToText.js` |
| Application + reference data | Firestore | `backend/src/adapters/firestore.js` |
| Authorised media assets | Cloud Storage | `backend/src/adapters/cloudStorage.js` |
| Aggregated retail analytics | BigQuery | `backend/src/adapters/bigquery.js` |
| Authentication / roles | Firebase Auth / Identity Platform | `backend/src/adapters/firebaseAuth.js` |
| Backend compute | Cloud Run | `backend/Dockerfile` |
| Frontend hosting + `/api` proxy | Firebase Hosting | `firebase.json` |
| Production secrets | Secret Manager | injected as env vars at deploy time |

Every adapter exposes a factory selected by a `*_MODE` env var (see
`backend/src/config.js`). The default **mock** mode is deterministic and fully
offline (no network, no third-party packages). The **Gemini** adapter also has
a working **live** mode that calls Google AI Studio's Generative Language API
over Node's built-in global `fetch` (no SDK, still zero dependencies); the other
adapters' live modes remain clearly-marked stubs for a deployed Google Cloud
environment. See [Live Gemini (Google AI Studio)](#live-gemini-google-ai-studio).

For the full request-flow diagram, see [`ARCHITECTURE.md`](ARCHITECTURE.md).

## The suggest / validate principle

> **Gemini generates understanding and recommendations. The application
> validates retail facts.** AI must not invent product identifiers, inventory,
> prices, rack locations, queue confirmations, or collection dates.

Gemini output (intent parsing, outfit *concepts*, styling rationale) is treated
as an **untrusted suggestion**. The following retail facts are resolved and
validated by **deterministic application code** against the seeded catalogue
data, never taken from the model:

- **SKU** - every purchasable item references a real catalogue SKU.
- **Price** - the catalogue price in RM.
- **Stock** - availability (in the requested size, at the branch).
- **Size** - size availability and size guidance.
- **Budget** - the assembled outfit total respects the mandatory budget cap.
- **Planogram location** - the exact in-store rack / shelf position.
- **Queue confirmation** - fitting-room queue state and staff confirmation.
- **Collection dates** - new-arrival / collection availability dates.

### Success guarantees

- **100%** of displayed purchasable recommendations respect the mandatory
  budget rules.
- **100%** of purchasable items reference valid catalogue SKUs.

When three valid, budget-compliant outfits cannot be formed, the app returns a
clear "cannot form three" response with the closest alternatives. It **never**
invents a product to reach three.

## Run the full stack offline (mocks)

**Requirements:** Node.js 22+, **zero external npm dependencies** (the package
registry is unreachable in the build environment). Everything uses the Node
standard library and the built-in `node:test` runner.

> **Environment quirk (`NODE_OPTIONS`):** the sandbox sets `NODE_OPTIONS` to a
> `--require` preload that does not exist, which makes every `node` invocation
> crash before it runs. Always strip the variable for the current command with
> `env -u NODE_OPTIONS node ...`. This affects running the server, the tests,
> and `node --check`. (Outside the sandbox, where `NODE_OPTIONS` is unset, plain
> `node ...` works too.)

```sh
# Start the full stack (backend API + static frontend) from one process
env -u NODE_OPTIONS node backend/src/server.js
# then open:
#   http://localhost:8080/                       customer app (Page-1 role chooser -> Shop flow)
#   http://localhost:8080/retailer-dashboard.html
#   http://localhost:8080/staff-dashboard.html
#   http://localhost:8080/healthz                health check (JSON)
#   http://localhost:8080/assets/scenes/beach.svg  example inline-SVG scene background
```

From `/`, pick **Shop** and walk the hash-routed flow (intent -> prompt ->
photo -> results); the three dashboards are reached from the same role chooser.

The backend serves the vanilla HTML/CSS/JS frontend statically (so a single
`node backend/src/server.js` runs the entire offline demo) while the frontend
stays independently deployable to **Firebase Hosting** (the root `firebase.json`
serves `frontend/` and rewrites `/api/**` + `/healthz` to the Cloud Run
backend). Product images are synthesised as inline SVG placeholders, so there
are **no binary assets and no network / CDN dependencies** at runtime.

## Run the tests

```sh
env -u NODE_OPTIONS node --test        # run the full node:test suite
env -u NODE_OPTIONS node --check backend/src/server.js   # syntax check
```

The suite includes the budget-compliance and valid-SKU guarantees described
above.

## Demo scenarios

The customer UI no longer has a one-click demo bar - the shopper walks the
multi-screen Shop flow (choose intent, then speak or type the prompt). The two
canonical scenarios below are still fully exercisable over the API, and you can
reproduce either one in the UI by typing the prompt on the `#/shop/prompt`
screen:

### 1. Port Dickson occasion (under RM250)

> "Sunset seafood dinner and photos in Port Dickson, stylish and comfortable,
> budget RM250."

```sh
curl -s http://localhost:8080/api/message \
  -H 'Content-Type: application/json' \
  -d '{"text":"sunset seafood dinner and photos in Port Dickson, stylish and comfortable, budget RM250"}'
```

Returns three coordinated looks, **all within RM250**, each composed only of
valid in-stock SKUs.

### 2. Latest arrivals (under RM300)

> "Show me the latest arrivals - relaxed tailoring and streetwear, under RM300."

```sh
curl -s http://localhost:8080/api/message \
  -H 'Content-Type: application/json' \
  -d '{"text":"latest arrivals, relaxed tailoring and streetwear, under RM300"}'
```

Returns three new-arrival looks, **all within RM300**.

Dashboards are gated by Firebase Auth role. Use the demo tokens
`demo-merchandiser` (retailer / merchandising) and `demo-associate` (staff),
e.g.:

```sh
curl -s http://localhost:8080/api/dashboard/retail \
  -H 'Authorization: Bearer demo-merchandiser'
```

## Mock to live: env var reference

Copy [`.env.example`](.env.example) to `.env` for local overrides. Most
services default to `mock` (deterministic, offline). **Gemini is the exception:
it runs LIVE automatically when `GEMINI_API_KEY` is set, and falls back to the
offline mock when no key is present** (see below). Set the other services to
`live` only in a deployed Google Cloud environment with the matching SDK and
credentials. In production, **secrets come from Secret Manager**, not from
`.env`.

| Env var | Switches | Default | Live meaning |
| --- | --- | --- | --- |
| `GEMINI_MODE` | Gemini NLU + styling + retail analysis | **live if `GEMINI_API_KEY` set, else mock** | Call Gemini via the Google AI Studio / Generative Language API. `GEMINI_MODE=mock` forces offline even with a key; `GEMINI_MODE=live` forces live |
| `GEMINI_API_KEY` | Gemini credential + live default trigger | *(empty)* | API key from Google AI Studio; presence flips Gemini to live by default; from Secret Manager in prod; never committed |
| `GEMINI_MODEL` | Gemini model id | `gemini-2.5-flash` | Target model (override to use the newest available id) |
| `VERTEX_IMAGE_MODE` | Virtual try-on | `mock` | Call Google Vertex AI image generation (real AI try-on image); falls back to the offline composite if the call fails or no access token is available |
| `GOOGLE_ACCESS_TOKEN` | Vertex AI OAuth token (live try-on) | *(empty)* | OAuth access token for Vertex AI; in Cloud Run / GKE this comes from Application Default Credentials. Absent -> live try-on falls back to the offline mock composite |
| `VERTEX_IMAGE_MODEL` | Image model id | `imagegeneration` | Vertex AI image model |
| `VERTEX_LOCATION` | Vertex AI region | `asia-southeast1` | Vertex AI / Gemini region |
| `SPEECH_MODE` | Voice to text | `mock` | Call Cloud Speech-to-Text |
| `SPEECH_LANGUAGE_CODE` | Recognition language | `en-MY` | Speech-to-Text language |
| `FIRESTORE_MODE` | App + reference data | `mock` | Call Firestore |
| `STORAGE_MODE` | Media assets | `mock` | Call Cloud Storage |
| `GCS_BUCKET` | Storage bucket | `scenefit-demo-assets` | Cloud Storage bucket |
| `BIGQUERY_MODE` | Analytics warehouse | `mock` | Call BigQuery |
| `BIGQUERY_DATASET` | Analytics dataset | `scenefit_analytics` | BigQuery dataset |
| `AUTH_MODE` | Auth / roles | `mock` | Verify Firebase Auth / Identity Platform tokens |
| `GOOGLE_CLOUD_PROJECT` | GCP project | `scenefit-demo` | Target project id |
| `FIREBASE_PROJECT` | Firebase project | `scenefit-demo` | Firebase project id |
| `GOOGLE_APPLICATION_CREDENTIALS` | SA key (local live only) | *(empty)* | Path to a service-account key; unset in Cloud Run (uses ADC). From Secret Manager, never committed |
| `PORT` | HTTP port | `8080` | Cloud Run sets this at runtime |

### Live Gemini (Google AI Studio)

The Gemini adapter ([`backend/src/adapters/gemini.js`](backend/src/adapters/gemini.js))
calls the Google AI Studio / Generative Language API. **Live is now the default
whenever a key is available**, so the AI-driven "thinking" parts (intent
parsing, outfit concepts, styling explanations, and retailer-dashboard
analysis) are live out of the box - the deterministic mock is only the offline
fallback:

- **`GEMINI_API_KEY` set, `GEMINI_MODE` unset -> LIVE.** Gemini runs live.
- **No key (and no `GEMINI_MODE`) -> MOCK.** Runs fully offline, nothing breaks.
  This is exactly what the sandbox / CI sees, so the whole test suite runs with
  zero network.
- **`GEMINI_MODE=mock` -> forced MOCK**, even if a key is present (useful to run
  fully offline on purpose).
- **`GEMINI_MODE=live` -> forced LIVE**; the adapter fails fast if the key is
  missing (a config mistake, distinct from a transient API failure).

Because the live adapter **always falls back to the deterministic mock on any
HTTP / transport / parse failure**, defaulting to live is safe at runtime: a
user who sets a key but hits a transient error still gets a working flow, and
the response source label (`gemini-live` vs `gemini-mock`) stays observable.

To run a local demo against live Gemini (just provide a key - no `GEMINI_MODE`
needed):

   ```sh
   GEMINI_API_KEY=your-key-here \
     env -u NODE_OPTIONS node backend/src/server.js
   # force offline even with a key:
   GEMINI_MODE=mock GEMINI_API_KEY=your-key-here \
     env -u NODE_OPTIONS node backend/src/server.js
   ```

**Model selection.** The default model is **`gemini-2.5-flash`**, overridable
via `GEMINI_MODEL`. Model ids change over time; discover the newest available
id for your key with the models-list endpoint:

```sh
curl -s "https://generativelanguage.googleapis.com/v1beta/models?key=$GEMINI_API_KEY"
```

**Trust boundary still holds in live mode.** The model only produces language
understanding and outfit *concepts*; the application still validates every
retail fact. Concretely, the live adapter: strips any price/stock/availability/
rack/queue/collection-date field the model tries to emit; references **only**
SKUs present in the candidate pool the app supplies (invented SKUs are dropped);
derives the Shop-page `scene` deterministically (never from the model); and, on
any HTTP or JSON-parse failure, **falls back to the deterministic mock** so a
transient model hiccup never breaks the shopping flow.

> **Not verified in this offline sandbox.** The build/test environment has no
> outbound network, so a real live Gemini call cannot be executed here. The live
> path is exercised by unit tests that stub `fetch`; verify end to end by running
> locally with your own key as shown above.

### Live AI-driven retailer insights (analysis / predictions / suggestions)

The retailer dashboard adds a **live AI analysis layer on top of the
deterministic BigQuery aggregates**. The aggregated numbers (occasion mix, style
demand, unmet-demand reasons, zone activity, commercial summary) remain the
**deterministic source of truth**; those real aggregates are passed to Gemini
(`gemini.analyzeRetail(aggregates)`), which returns only:

- a concise natural-language **analysis / narrative** of what the data shows;
- **trend predictions**, clearly labelled as model-generated, **non-guaranteed**
  forecasts (`guaranteedForecast: false`);
- actionable **merchandising suggestions** (human decision-support).

How facts and numbers are protected from the model:

- The AI output is **additive** - it appears as a new `aiInsights` block on
  `/api/dashboard/retail` and an `aiAnalysis` block on
  `/api/dashboard/merchandising`, **alongside** (never replacing) the
  deterministic sections. The displayed numbers always come from BigQuery.
- The model response runs through the same `stripRetailFields` guard, so it can
  never smuggle a fabricated price / stock / SKU / rack location / date into the
  insights.
- The block is stamped `aiGenerated: true`, `interpretation: 'decision-support'`,
  `guaranteedForecast: false`, `autoReorder: false`, and `source`
  (`gemini-live` / `gemini-mock`).
- On any live failure the analysis **falls back to a deterministic mock
  analysis** derived from the same aggregates, so the dashboard never breaks.
  Offline (no key) it is the mock analysis by default.

The dashboard surfaces this in a clearly-labelled **"AI analysis & predictions
(model-generated, non-guaranteed)"** panel, visually distinct from the hard
aggregated numbers.

### Live Vertex AI try-on images

The virtual try-on can now render **real Google Vertex AI image generations**
instead of the offline placeholder swatch. When `VERTEX_IMAGE_MODE=live` **and**
a Vertex AI OAuth access token is available (`GOOGLE_ACCESS_TOKEN`, or
Application Default Credentials in Cloud Run / GKE), the adapter POSTs to the
Vertex AI `:predict` endpoint and returns the generated image bytes as a data
URL, which the frontend displays. If the call fails, or no token is present
(e.g. the offline sandbox), it **falls back to the deterministic offline
composite** so the try-on flow never breaks. Every try-on visual stays an
**illustrative aid only** - never a guarantee of fit, colour, drape, or
measurements.

> **Not verified in this offline sandbox.** Real Vertex AI calls require network
> + credentials that the sandbox does not have; the live path is exercised by
> unit tests that stub `fetch`. Verify end to end locally with a token.

## Deploy notes (Cloud Run + Firebase Hosting)

> These steps are **not executed in the sandbox** - the offline build
> environment cannot pull base images, install SDKs, or reach Google Cloud APIs.
> The manifests are written and structurally reviewed as deploy-time artifacts.

**Backend on Cloud Run** ([`backend/Dockerfile`](backend/Dockerfile)):

```sh
# Build (pulls the Google-published Node base image) and deploy.
gcloud builds submit \
  --tag asia-southeast1-docker.pkg.dev/<project>/scenefit/backend
gcloud run deploy scenefit-backend \
  --image asia-southeast1-docker.pkg.dev/<project>/scenefit/backend \
  --region asia-southeast1 --allow-unauthenticated \
  --set-env-vars GEMINI_MODE=live,VERTEX_IMAGE_MODE=live,SPEECH_MODE=live,FIRESTORE_MODE=live,STORAGE_MODE=live,BIGQUERY_MODE=live,AUTH_MODE=live \
  --set-secrets GEMINI_API_KEY=scenefit-gemini-key:latest
```

Cloud Run injects `$PORT`; the server reads `process.env.PORT || 8080` (via
`backend/src/config.js`) and binds `0.0.0.0`.

**Frontend on Firebase Hosting** (root [`firebase.json`](firebase.json)):

```sh
firebase deploy --only hosting,firestore:rules,storage:rules
```

Hosting serves `frontend/` and rewrites `/api/**` and `/healthz` to the
`scenefit-backend` Cloud Run service in `asia-southeast1`. The three customer
screens are **client-side hash routes under a single `index.html`**, so no SPA
rewrite config is required - Firebase serves `index.html` at `/` and the hash
routing happens entirely in the browser; the retailer and staff dashboards
remain their own `.html` files served directly.
[`firestore.rules`](firestore.rules) and [`storage.rules`](storage.rules) are
deny-by-default and role-based. [`.firebaserc`](.firebaserc) carries a
placeholder project id (`scenefit-demo`) - replace it with the real project.

> There is a single authoritative `firebase.json` at the repo root. The earlier
> per-frontend copy was consolidated into it to avoid conflicting hosting
> configs.

## MVP scope vs future phases

**In scope (this MVP):** voice/text intent capture, Gemini-suggested + app
-validated three-outfit recommendations with hard budget and SKU guarantees,
virtual try-on previews, size guidance, in-store rack navigation, staff-assisted
collection, smart fitting-room queue, cart / checkout handoff, and retailer /
staff / merchandising dashboards - all running offline against deterministic
mocks, with Google-only deploy manifests written for Cloud Run + Firebase
Hosting.

**Future phases (not in this MVP):** live Google service integrations wired end
to end (Gemini, Vertex AI image, Speech-to-Text, Firestore, Cloud Storage,
BigQuery, Firebase Auth), real inventory / POS integration, personalised
recommendation history, richer try-on fidelity, multi-store / multi-retailer
onboarding, and production observability and A/B experimentation.

## Project layout

```
backend/
  Dockerfile             # Cloud Run image (Google base image; deploy-time)
  src/
    config.js            # env -> per-service adapter mode selection
    server.js            # Node http server (reads PORT, binds 0.0.0.0)
    static.js            # static file handler serving frontend/ + synth assets
    adapters/            # one module per Google service (mock + live stub)
    services/            # deterministic retail logic (outfit engine, queue, ...)
  data/                  # seeded catalogue / collections / planogram / analytics
  test/                  # node:test suites
frontend/                # vanilla HTML/CSS/JS web app (zero build step, offline)
  index.html             # multi-screen customer app shell (Page-1 role chooser + Shop flow)
  retailer-dashboard.html# retailer intelligence + merchandising insights
  staff-dashboard.html   # staff operations (picking, fitting rooms, queue)
  css/styles.css         # mobile-first responsive styles (no external libs)
  js/                    # api.js (fetch wrapper), app.js (hash router), dashboard scripts
shared/contracts/        # JSON/JSDoc shapes shared by frontend & backend
firebase.json            # authoritative Firebase Hosting + rules config
.firebaserc              # Firebase project alias (placeholder project id)
firestore.rules          # role-based, deny-by-default Firestore rules
storage.rules            # authorised-media Cloud Storage rules
.env.example             # every adapter-switching env var (defaults to mock)
ARCHITECTURE.md          # request-flow + trust-boundary deep dive
```

See [`backend/data/README.md`](backend/data/README.md) for the seed data and the
two demo scenarios plus the low-budget "cannot form three" fallback and the
rack-location example.

## Google-only statement

SCENEFIT AI uses **Google services exclusively** - Gemini, Vertex AI image
generation, Cloud Speech-to-Text, Cloud Run, Firebase Hosting, Firestore, Cloud
Storage, BigQuery, Firebase Auth / Identity Platform, and Secret Manager. **No
non-Google cloud, AI, or model provider is used anywhere** in the code,
configuration, dependencies, examples, or documentation.

Virtual try-on composites are **illustrative aids only** - they are not
guarantees of fit, colour accuracy, or final appearance.
