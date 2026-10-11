# SCENEFIT AI - Architecture

This document describes how a shopper utterance becomes exactly three
budget- and SKU-validated outfit recommendations, and where the hard boundary
between **AI suggestion** and **deterministic retail validation** sits.

> **Gemini generates understanding and recommendations. The application
> validates retail facts.** Gemini must not invent product identifiers,
> inventory, prices, rack locations, queue confirmations, or collection dates.

## Google-only service map

| Capability | Google service | Adapter module |
| --- | --- | --- |
| Language understanding + styling suggestions | Gemini (Vertex AI / Generative Language API) | `backend/src/adapters/gemini.js` |
| Virtual try-on image generation | Vertex AI image generation | `backend/src/adapters/vertexImage.js` |
| Voice to text | Cloud Speech-to-Text | `backend/src/adapters/speechToText.js` |
| Application + reference data | Firestore | `backend/src/adapters/firestore.js` |
| Authorised media assets | Cloud Storage | `backend/src/adapters/cloudStorage.js` |
| Aggregated retail analytics | BigQuery | `backend/src/adapters/bigquery.js` |
| Authentication / roles | Firebase Auth / Identity Platform | `backend/src/adapters/firebaseAuth.js` |
| Backend compute | Cloud Run | `backend/Dockerfile` |
| Frontend hosting + API proxy | Firebase Hosting | `firebase.json` |
| Production secrets | Secret Manager | injected as env vars at deploy time |

Each adapter exposes a factory selected by a `*_MODE` env var (see
`backend/src/config.js`). The default **mock** mode is deterministic and fully
offline. The **live** mode lazily requires the Google SDK inside the function
body so module load never fails offline.

## Request flow (utterance to recommendation)

```
  Shopper utterance (voice or text)
        |
        v
  [1] speechToText(mock)            adapters/speechToText.js
        |   voice audio -> transcript (text input skips this step)
        v
  [2] gemini.parseIntent            adapters/gemini.js   (UNTRUSTED understanding)
        |   transcript -> structured intent:
        |     { occasion, vibe, budgetRM, categories, constraints, ... }
        v
  [3] catalogue candidate pool      services/catalogue.js + Firestore
        |   deterministic query over seeded catalogue/inventory:
        |     in-stock, in-season, size-available, within/near budget SKUs
        v
  [4] gemini.proposeOutfits         adapters/gemini.js   (UNTRUSTED suggestion)
        |   candidate pool + intent -> outfit *concepts* (role -> SKU picks
        |   + styling rationale). Treated as a hint only.
        v
  [5] outfitEngine deterministic validation   services/outfitEngine.js
        |   For every proposed item the engine re-resolves the TRUTH from the
        |   catalogue and ENFORCES:
        |     - SKU exists in the catalogue           (100% valid-SKU guarantee)
        |     - price is the catalogue price (RM)
        |     - item is in stock in the requested size
        |     - the assembled outfit total <= budget  (100% budget-compliance)
        |   Invalid / hallucinated picks are dropped and replaced from the
        |   validated candidate pool.
        v
  [6] Three outfits  OR  clear fallback
        |   If three valid, budget-compliant outfits cannot be formed, return a
        |   clear "cannot form three" response with the closest alternatives.
        |   The app NEVER invents a product to reach three.
        v
  [7] Downstream retail services (all deterministic):
        - tryOn            virtual try-on composite (illustrative aid only)
        - storeNavigation  exact rack / planogram location per SKU
        - fittingRoomQueue smart fitting-room queue + staff confirmation
        - staffTasks       staff-assisted product collection
        - cart / checkout  omnichannel handoff
        - analytics        aggregated reporting (server-side -> BigQuery)
```

## Deterministically validated retail facts

The following facts are **never** taken from Gemini output. They are resolved
and validated by application code against the seeded Firestore data:

- **SKU** - every purchasable item references a real catalogue SKU.
- **Price** - the catalogue price in RM, not an AI-stated number.
- **Stock** - availability in the requested size at the branch.
- **Size** - size availability and size guidance.
- **Budget** - the assembled outfit total respects the mandatory budget cap.
- **Planogram location** - the exact in-store rack / shelf position.
- **Queue confirmation** - fitting-room queue state transitions and staff
  confirmation.
- **Collection dates** - new-arrival / collection availability dates.

## Success guarantees

- **100%** of displayed purchasable recommendations respect the mandatory
  budget rules.
- **100%** of purchasable items reference valid catalogue SKUs.

These are enforced by `services/outfitEngine.js` and covered by the budget and
valid-SKU tests in `backend/test/`.

## Trust boundary summary

- **Trusted (deterministic app code):** catalogue, inventory, pricing,
  planogram, queue, collection dates, analytics, budget enforcement, SKU
  validity.
- **Untrusted (AI suggestion only):** Gemini intent parse and outfit concepts;
  Vertex AI try-on composites (illustrative aids, not fit/colour guarantees).
