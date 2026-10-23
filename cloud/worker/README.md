# supercarto-compile — Cloudflare Worker

A hosted HTTP surface for the supercarto compile. Same tool subset as the local
API in `src/server/http.ts`, same conventions, implemented by importing the real
pipeline (`src/live.ts` → `src/pipeline.ts` → `src/emit`) rather than copying
it, so the hosted and local answers cannot drift.

## What it serves

| Route | What it returns |
| --- | --- |
| `GET /` | JSON index of routes, plus an honest list of what is not served and why |
| `GET\|POST /maplet?lat=&lon=&radiusM=&budget=&layers=&format=yaml\|json` | token-budgeted maplet. Default format `yaml` → `text/plain` with token metrics in an `X-Maplet-Metrics` header; `format=json` mirrors the local server's JSON body exactly |
| `GET /scr?bbox=w,s,e,n` | raw SCR wire document, `text/plain` |
| `GET /daylight?lat=&lon=&at=` | sun elevation, azimuth, twilight state, sunrise/sunset. Computed locally — no network, no credential |
| `GET /weather?lat=&lon=&hours=` | Open-Meteo conditions and short forecast. Keyless. A degraded source answers `503`, never zeroed conditions presented as weather |
| `GET /terrain?lat=&lon=&radiusM=&samples=` | elevation min/max/range from Terrarium tiles. Keyless |
| `GET /healthz` | `200` when the configured Overpass instance is reachable, `503` otherwise; result cached 60s so health checks do not load the shared instance |

Every `/maplet` and `/scr` response carries `X-Data-Attribution: © OpenStreetMap contributors (ODbL)`. That is a licence term of the map data, not a nice-to-have; keep it if you operate this publicly. Run the endpoint only with open-data-licensed sources (Overpass/OSM, Open-Meteo, Terrarium are all included by default — all keyless).

## What it honestly does not

The `GET /` index lists these with reasons, in the same voice as the rest of
the project — "not there" is not "not shown":

- **`/transit`** — a schedule needs an operator-imported GTFS feed read from the
  local filesystem. A Worker has no filesystem, so transit is absent rather
  than served as "no service".
- **`get_traffic`** — live traffic needs a licensed flow provider credential
  (TomTom or HERE). Hosted mode ships none: free-flow numbers presented as live
  conditions are the failure this library refuses to make.
- **indoor / PMTiles map sources** — indoor floor plans and PMTiles archives
  are local files. The hosted maplet layers come only from live Overpass.

## Rate limiting

30 maplet requests per minute per IP, fixed window, in-memory, on the `/maplet`
route only (it is the one whose cost lands on the shared Overpass instance).
Over the limit: `429` with `Retry-After` and a message that says what it is.

This is **best-effort, not a hard guarantee**: Workers isolate state per
isolate, so different isolates count separately. For an actual guarantee, use a
Durable Object counter or Cloudflare's managed rate limiting. The 429 message
states this openly.

## Deploy

```bash
npx wrangler deploy    # from cloud/worker/ — wrangler bundles the TS entry itself
npx wrangler dev       # local run against real sources
```

There is no build script and no npm dependency, including here: wrangler's own
bundler consumes `src/worker.ts`, and the imports reach up into `../../..`/`src`
by relative path. `nodejs_compat` is **not** set — the compile path uses only
`fetch`, `URL`, and `AbortController`; the modules that touch `node:*` built-ins
(GTFS, PMTiles, the binary compressor, `src/index.ts`) are never imported.

Optional Wrangler variables: `OVERPASS_ENDPOINT` and `TERRARIUM_ENDPOINT`, to
point the health probe and elevation at your own instances.

## Tests

Plain `Request`/`Response`/`fetch` code — no Cloudflare APIs beyond the
`cf-connecting-ip` header — so the suite runs in Node, without wrangler:

```bash
npx vitest run -c cloud/worker/vitest.config.ts
npx tsc --noEmit -p cloud/worker/tsconfig.json
```
