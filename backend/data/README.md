# SCENEFIT AI - Seed Data

All seed data is deterministic and used by the offline mock adapters (Firestore,
BigQuery, etc.). Prices are in **RM (Malaysian Ringgit)**.

> **Boundary principle:** Gemini generates understanding and recommendations;
> the application validates retail facts. These JSON files are the authoritative
> source of retail facts (valid SKUs, prices, stock, size availability, rack
> locations, collection/arrival dates). Gemini output is only ever a suggestion.

## Files

| File | Contents |
| --- | --- |
| `retailer.json` | Single demo retailer (Google Cloud project `scenefit-demo`). |
| `store.json` | Demo Flagship store, Level 2, zones A/B/C, fitting rooms. |
| `products.json` | ~26 SKUs across top / bottom / footwear / outerwear / accessory, each with RM price, colours, styles, `collectionId`, `newArrival` + `arrivalDate`, and per-size stock variants. |
| `collections.json` | Collections with release dates and new-arrival tags, including the current **latest** drop (`col-latest-2025ss`). |
| `sizeCharts.json` | Per-category size charts with measurement ranges (top, bottom, footwear, accessory). |
| `planogram.json` | Rack location per SKU (floor / zone / aisle / rack / shelf + directions), including the **F09** example. |
| `analyticsEvents.json` | Privacy-protected (no PII), aggregation-ready sample events: `intent`, `demand`, `unmet_demand`, `in_store`, `commercial`. |

## Demo scenarios

### 1. Port Dickson occasion - "Style My Moment" (budget RM250)
Resort / linen pieces form **three distinct outfits under RM250**:

- `TOP-LIN-001` + `BOT-SHT-010` + `FTW-SND-020` = RM237
- `TOP-LIN-002` + `BOT-CHN-011` + `FTW-ESP-021` = RM217
- `TOP-PIQ-003` + `BOT-SWT-015` + `FTW-SNK-022` = RM227

### 2. Latest arrivals - "Explore What's New" (budget RM300)
All-latest-collection relaxed-tailoring / streetwear forms **three distinct
outfits under RM300**:

- `TOP-GRA-006` + `BOT-TRS-012` + `FTW-CNV-025` = RM257
- `TOP-OXF-004` + `BOT-CRG-013` + `FTW-RUN-023` = RM293
- `TOP-KNT-005` + `BOT-DNM-014` + `FTW-LOF-024` = RM297

### 3. Low-budget fallback (budget ~RM80)
The cheapest possible three-piece outfit is RM197, so **three outfits cannot be
formed** under RM80. The deterministic engine must return a clear "cannot form
three" response with alternatives - never invent products. See the
`unmet_demand` event `evt-0009`.

## F09 rack-location example

`TOP-OXF-004` (`plano-TOP-OXF-004`, `exampleRef: "F09"`):

- **Store:** Demo Flagship Level 2
- **Zone:** Zone B New Arrivals
- **Aisle:** Aisle 04
- **Rack:** Rack B-17
- **Shelf:** Upper Rail
- **Directions:** From the Level 2 escalator, turn right into Zone B New
  Arrivals and walk to Aisle 04. The piece is on Rack B-17, Upper Rail.
