# SCENEFIT AI

**Your Plans. Your Trends. Your Look.**

A **Google-only** voice/text multimodal fashion shopping assistant and retailer
intelligence platform. SCENEFIT AI turns a shopper's described moment (an
occasion or "what's new") into exactly three coordinated, budget- and
SKU-validated outfit recommendations, with virtual try-on, size guidance,
in-store rack navigation, staff-assisted collection, a fitting-room queue, and
retailer / staff / merchandising dashboards.

## Critical architectural principle

> **Gemini generates understanding and recommendations. The application
> validates retail facts.** AI must not invent product identifiers, inventory,
> prices, rack locations, queue confirmations, or collection dates.

Gemini output (intent parsing, outfit *concepts*, styling rationale) is treated
as an untrusted suggestion. Every retail fact - valid SKUs, prices (in **RM**),
stock, size availability, budget compliance, rack/planogram location, queue
confirmation, collection/new-arrival dates - is resolved and validated by
deterministic application code against the seeded catalogue data.

## Google-only cloud architecture

The only cloud / AI providers this project targets are Google:

| Concern | Google service | Adapter |
| --- | --- | --- |
| Language understanding + styling suggestions | Gemini (Vertex AI / Generative Language API) | `backend/src/adapters/gemini.js` |
| Virtual try-on image generation | Vertex AI image generation | `backend/src/adapters/vertexImage.js` |
| Voice to text | Cloud Speech-to-Text | `backend/src/adapters/speechToText.js` |
| Document data | Firestore | `backend/src/adapters/firestore.js` |
| Object storage | Cloud Storage | `backend/src/adapters/cloudStorage.js` |
| Analytics warehouse | BigQuery | `backend/src/adapters/bigquery.js` |
| Auth | Firebase Auth / Identity Platform | `backend/src/adapters/firebaseAuth.js` |
| Hosting / compute | Firebase Hosting + Cloud Run | deploy manifests (later features) |
| Secrets | Secret Manager | `GEMINI_API_KEY` etc. (never committed) |

Every adapter exposes a `create<Service>({ mode })` factory. The default
**mock** mode is deterministic and fully offline (no network, no third-party
packages). The **live** mode is a clearly-marked stub that lazily requires the
Google SDK inside the function body, so module load never fails offline.

## Requirements & running

- **Node.js 22+**, **zero external npm dependencies** (the package registry is
  unreachable in the build environment). Everything uses the Node standard
  library and the built-in `node:test` runner.

> **Environment quirk:** the sandbox sets `NODE_OPTIONS` to a preload that does
> not exist and crashes Node. Always invoke Node with the variable stripped:
>
> ```sh
> env -u NODE_OPTIONS node backend/src/server.js   # start the server
> env -u NODE_OPTIONS node --test                  # run the test suite
> ```

```sh
# Start the backend (defaults to offline mock mode for all Google services)
env -u NODE_OPTIONS node backend/src/server.js
# -> GET http://localhost:8080/health

# Run tests
env -u NODE_OPTIONS node --test
```

Copy `.env.example` to `.env` to adjust ports, Google project settings, and
per-service `*_MODE` toggles. Every service defaults to `mock`.

## Project layout

```
backend/
  src/
    config.js            # env -> per-service adapter mode selection
    server.js            # Node http server (scaffold; routes added later)
    adapters/            # one module per Google service (mock + live stub)
    services/            # deterministic retail logic (added in later features)
  data/                  # seeded demo catalogue / collections / planogram / analytics
  test/                  # node:test suites
frontend/                # vanilla HTML/CSS/JS web app (added in later features)
shared/contracts/        # JSON/JSDoc shapes shared by frontend & backend
```

See [`backend/data/README.md`](backend/data/README.md) for the seed data and the
two demo scenarios (Port Dickson under RM250, latest arrivals under RM300) plus
the low-budget "cannot form three" fallback and the F09 rack-location example.
