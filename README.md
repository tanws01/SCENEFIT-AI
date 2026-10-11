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
2. [Google-only architecture](#google-only-architecture)
3. [The suggest / validate principle](#the-suggest--validate-principle)
4. [Run the full stack offline (mocks)](#run-the-full-stack-offline-mocks)
5. [Run the tests](#run-the-tests)
6. [Demo scenarios](#demo-scenarios)
7. [Mock to live: env var reference](#mock-to-live-env-var-reference)
8. [Deploy notes (Cloud Run + Firebase Hosting)](#deploy-notes-cloud-run--firebase-hosting)
9. [MVP scope vs future phases](#mvp-scope-vs-future-phases)
10. [Project layout](#project-layout)
11. [Google-only statement](#google-only-statement)

## Product overview

SCENEFIT AI is a mobile-first web app backed by a JSON REST API. A shopper
speaks or types what they are shopping for ("sunset dinner in Port Dickson,
stylish but comfortable, under RM250"); the assistant understands the moment and
returns three complete, coordinated looks that are guaranteed to be within
budget and composed only of real, in-stock catalogue items. From there the
shopper can preview a virtual try-on, get size guidance, find the exact rack in
store, join the fitting-room queue, request staff-assisted collection, and hand
off to checkout. Retailer, staff, and merchandising dashboards surface
aggregated retail intelligence.

The entire stack runs **fully offline** with deterministic mocks for every
Google Cloud service, so the demo needs no network, no credentials, and no
third-party packages.

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
offline (no network, no third-party packages). The **live** mode is a
clearly-marked stub that lazily requires the Google SDK inside the function body,
so module load never fails offline.

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
#   http://localhost:8080/                       customer shopping app
#   http://localhost:8080/retailer-dashboard.html
#   http://localhost:8080/staff-dashboard.html
#   http://localhost:8080/healthz                health check (JSON)
```

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

The customer app has two one-click demo buttons that pre-fill and send the
canonical scenarios end to end. Both can also be driven over the API:

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

Copy [`.env.example`](.env.example) to `.env` for local overrides. Every
service defaults to `mock` (deterministic, offline). Set a service to `live`
only in a deployed Google Cloud environment with the matching SDK and
credentials. In production, **secrets come from Secret Manager**, not from
`.env`.

| Env var | Switches | Default (mock) | Live meaning |
| --- | --- | --- | --- |
| `GEMINI_MODE` | Gemini NLU + styling | `mock` | Call Gemini via Vertex AI / Generative Language API |
| `GEMINI_API_KEY` | Gemini credential | *(empty)* | From Secret Manager; never committed |
| `GEMINI_MODEL` | Gemini model id | `gemini-1.5-flash` | Target model |
| `VERTEX_IMAGE_MODE` | Virtual try-on | `mock` | Call Vertex AI image generation |
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
`scenefit-backend` Cloud Run service in `asia-southeast1`.
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
  index.html             # customer shopping assistant (voice + text, outfit cards)
  retailer-dashboard.html# retailer intelligence + merchandising insights
  staff-dashboard.html   # staff operations (picking, fitting rooms, queue)
  css/styles.css         # mobile-first responsive styles (no external libs)
  js/                    # api.js (fetch wrapper), app.js, dashboard scripts
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
