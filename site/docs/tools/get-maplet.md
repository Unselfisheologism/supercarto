---
title: get_maplet
description: The core call — a walkable, token-budgeted topological graph of any coordinate.
sidebar:
  label: get_maplet
  order: 0
---

always advertised

`get_maplet(lat, lon, radius, layers, budget)` — the single call that
produces the product. Fetches real geodata around a coordinate, compiles a
topological graph, cuts it to your budget, and emits YAML.

| Prop | Type | Default | Description |
| - | - | - | - |
| `lat` | `number` | - | Latitude in [-90, 90]. |
| `lon` | `number` | - | Longitude in [-180, 180]. |
| `radius?` | `number` | - | Radius in metres. Kept sane at the interface. |
| `budget?` | `number` | - | Token budget for the emitted YAML. |
| `layers?` | `string[]` | - | Layer filter. Raw OSM tag selectors are also taken; anything else is rejected rather than silently returning nothing. |

## The output

Nodes, edges, and — this is the part that makes it honest — omissions:

```yaml
map:
  center: "35.6833, 139.762"
  radius: 400m
nodes:
  n186: {type: transit, name: 新橋駅(3), tags: [subway_entrance]}
edges:
  n1->n2: {dist: 120m, dir: east, path: road}
omitted:
  - {layer: feature, count: 1754}
tools:
  - expand_feature(id)
```

:::note[Order of operations]
Ranking first (named landmarks survive), then connectivity-preserving
cuts (a cut vertex is never removed), then stranded-name removal (a
landmark the agent cannot route to is removed), then re-measure the
actual emitted YAML and cut again until it fits. The budget is the
budget delivered, not an estimate.
:::

## What a node can carry

Beyond topology: `hours` (evaluated in the map's timezone — a known-closed
shop at 04:00 reads `closed`, a bench with no recorded hours emits no
`hours` at all), `sun` and `twilight` in the `map` header, `transit` nodes,
`indoor` floors, and the `tools:` list at the foot.

The `omitted:` section exists so the model can tell **not there** from
**not shown**. An agent reading only this block still knows the map is an
excerpt.
