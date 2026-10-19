# Jakarta-Monas maplet example

One small bounded capture of a real area near Monas, Central Jakarta, compiled
offline into token-budgeted maplet graphs. It exists so a GIS developer can see
whether a compact street graph adds useful context over a list of places, and
can check each claim the emitted graph makes.

The capture is real OpenStreetMap data. Do not replace these files with
synthetic output; synthesize for tests only (see `examples/synthetic-dense.geojson`).

## One offline command

```bash
npm run example:jakarta-monas
```

This runs, in order:

1. `compile-offline.ts` — compiles `jakarta-monas.geojson` at 1,024 and 2,048
   token budgets and rewrites `jakarta-monas-{1024,2048}.yaml` and
   `maplet-summary.json`. Reads only committed files; no network.
2. `path-check.ts` — answers whether a directed path exists between two named
   places in the emitted graph, prints the supporting node and edge ids, and
   audits every claimed join against `raw-overpass.json`.

A fresh checkout reproduces the committed YAML and summary byte-for-byte,
because every time-dependent input is frozen to the capture:

- `now` = `capture-meta.json` `timestamp` (`2026-10-19T13:35:14.524Z`)
- `utcOffsetMinutes` = 420 (WIB; Jakarta observes no DST)
- `bbox` = the recorded capture box

## Files

| file | what it is |
| --- | --- |
| `capture-overpass.ts` | one-time capture script (network, run by hand; at most one retry, stops on rate limiting) |
| `raw-overpass.json` | the raw Overpass response, never edited |
| `capture-meta.json` | machine-readable date, bbox, warnings, attribution |
| `jakarta-monas.geojson` | the features the compiler ingests, exactly `raw-overpass.json` as parsed |
| `CAPTURE.md` | capture record: date, bbox, queries sent, attribution |
| `jakarta-monas-1024.yaml` | maplet at a 1,024-token estimate budget |
| `jakarta-monas-2048.yaml` | maplet at a 2,048-token estimate budget |
| `maplet-summary.json` | sizes, token estimates, retained places, directed edge-class counts, component totals with singleton kinds, omissions, per-budget warnings |
| `path-check.ts` | directed-path check and raw-data join audit; every audit count names its unit |

All token figures are engine estimates (characters/4). They are estimates, not
tokenizer counts.

## Area and capture record

Center: Monas, Central Jakarta (lat -6.1754, lon 106.8272), radius about 300 m.
Bounding box: west 106.824489, south -6.178113, east 106.829911, north -6.172687.
Endpoint: the public Overpass instance. Date: 2026-10-19. One clean request; no
retry was needed. Attribution: © OpenStreetMap contributors, ODbL.

The capture warned that one feature came back with coordinates outside the box;
the adapter discarded it and recorded the warning. `capture-meta.json` carries
it, `maplet-summary.json` reports it.

## What the two budgets say

| | 1,024 estimate | 2,048 estimate |
| --- | --- | --- |
| YAML bytes | 3,629 | 6,560 |
| Token estimate (chars/4) | 908 | 1,640 |
| Named places retained | 8 | 8 |
| Directed road edges | 2 | 8 |
| Directed sidewalk edges | 20 | 38 |
| Directed access edges | 16 | 16 |
| Components: total / with edges / singletons | 4 / 4 / 0 | 39 / 5 / 34 |
| Singleton kinds (nodes) | none | poi 3, area 21, building 10 |
| Omitted (largest) | 81 waypoints, 11 road segments | 79 waypoints |

Edge counts are directed (unit: directed edges); a two-way street is recorded
twice, once per direction. At 2,048 the maplet keeps more of everything,
including detached area, building and toilet nodes with no access edge, so it
reports the 34 singletons. At both budgets the retained names are the same
eight (the four named Monas gardens, Taman Monas, the monument, a fountain and
a ticket booth), because the capture contained 16 named elements total and the
budgeter keeps what it can reach.

Warnings are rebuilt fresh for each budget: the capture warnings, then one
omissions line only when that budget dropped something.

## Access edges: what they are and are not

`path: access` edges are built by the compiler as **straight-line proximity
links**: from a place polygon's centroid to its nearest network vertex, so a
place "is not orphaned" from the graph. The join classes them as compiler-built
proximity links, not street joins: both ends are in the raw capture, but the
line between them is a straight-line approximation. They are,

- **not verified entrances** — no gate or door geometry supports them, and
- **not walking routes** — no observed street lies between the endpoints, and a
  turn claim invented there would be navigation fiction.

Street edges (`path: road`, `path: sidewalk`) are the opposite case: each is
verified per endpoint against the raw way the edge claims to walk on.

## Path check, and what it does not claim

`Monas Barat -> Taman Monas` has a directed path at both budgets:
`n112 -> n8 -> n10 -> n5 -> n6 -> n7 -> n113`, all edges mirrored in the
opposite direction, composed of 6 directed edges: 4 sidewalk + 2 access + 0
road. The audit verifies 8 of 8 street endpoint joins against
`raw-overpass.json` (shared vertices within 1 m), unit: endpoint joins, and
2 of 2 access edges with both ends in the raw data, unit: access edges. Per
the section above, those 2 access edges carry no navigation claim.

`Loket -> Monas Barat` is disconnected at both budgets: the ticket booth sits on
its own island. This is a valid answer, and an example of the honesty rule:
disconnected, omitted or unknown, reported rather than smoothed over.

None of this is navigation accuracy. There are no turn claims here: the path is
a feasibility statement over the emitted graph, and every distance is a grid
measurement, not a surveyed road length.
