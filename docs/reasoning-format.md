# The reasoning format

This is what an AI agent actually reads. It is deliberately **not** SCR.

---

## 1. The impedance mismatch

The GIS world speaks in vector tiles, PostGIS, GeoJSON, and WKT: geometries,
coordinates, and indices. The LLM world speaks in tokens, named entities, and
topological relationships.

An agent given a raw `FeatureCollection` for a single city block spends
thousands of tokens on coordinate pairs it cannot use. A model is bad at
Cartesian arithmetic over tile coordinates and good at reading about places and
the paths between them. So supercarto compiles one into the other:

- **SCR** is the wire format. Compact, integer, delta-encoded, streamed and
  zstd'd by machines. An agent never sees it.
- **The reasoning format** is a topological YAML graph using only constructs a
  model has read billions of times during pre-training.

Zero novel syntax. That is the entire design.

---

## 2. Shape

```yaml
map:
  center: "37.7749, -122.4194"
  radius: 400m
  source: osm
  note: Simplified for reasoning; call expand_node for exact geometry.
nodes:
  n1: {type: intersection}
  n2: {type: intersection}
  n3: {type: intersection, name: "Mission St & 5th St"}
  n4: {type: poi, name: "Blue Bottle Coffee", tags: [cafe, food]}
  n5: {type: transit, name: "Powell St Station", tags: [subway]}
  n6: {type: building, name: "Yerba Buena Tower", tags: [commercial], height: 108m}
edges:
  n1->n2: {dist: 120m, dir: east, path: road}
  n2->n3: {dist: 85m, dir: north, path: sidewalk, crosswalk: true}
  n3->n4: {dist: 40m, dir: west, path: access}
  n3->n5: {dist: 210m, dir: south, path: sidewalk, crosswalk: true}
  n3->n6: {dist: 65m, dir: north, path: access}
obstacles:
  - {edge: "n2->n3", type: construction, blocks: true}
heat:
  crowd_density: {max: 97, mean: 12.4}
    - {at: "37.7752,-122.4141", v: 97, rel: 0.97}
omitted:
  - {layer: building, count: 137, near: "37.7745,-122.4145"}
tools:
  - expand_node(id)
  - expand_feature(id)
  - get_maplet(lat,lon,radius,layers,budget)
  - route(from,to,mode)
```

---

## 3. Why each decision

**Flow style, one line per record.** `{type: poi, name: "..."}` on a single line
keeps the structure visible while removing indentation tokens. A block-style
YAML graph of 40 nodes costs roughly 40% more for the same information.

**Distances in metres, never grid units.** `dist: 120m` is directly usable.
`dist: 2048u` requires the model to know the scale. When the real-world scale
genuinely cannot be determined, the emitter writes `dist: 2048u` with a `u`
suffix rather than fabricating a metre value, and writes `dist: unknown` rather
than `NaN`. A model will read `NaN` as a number.

**Compass directions, not deltas.** `dir: east` is one token the model
understands instantly. `dx: +2048` demands arithmetic the model performs badly.
Distances are given so the model never has to derive them either.

**Named landmarks as first-class nodes.** A cafe is a node with a name and tags,
not a coordinate in a polygon. This is what turns geometry into something an
agent can answer questions about.

**`path:` on every edge.** `sidewalk` versus `highway` versus `stairs` changes
whether a route is legal for a pedestrian, a wheelchair, or a vehicle. It is a
few tokens and often the whole answer.

**Bidirectional edges by default.** An agent reading a directed graph assumes
one-way semantics. Both directions are emitted explicitly, so the model never
has to infer reversibility.

**`tools:` always present.** The agent is told what it may ask for, so it never
invents a tool name or assumes it has more detail than it does.

---

## 4. Honesty as a design constraint

The `omitted:` block is not decoration. It is the most important block in the
document.

An agent handed a silently-truncated map will reason over it confidently and
produce a confidently wrong answer: "the building is not there" rather than "the
building was dropped to fit the budget". The omission block converts a silent
lie into a stated uncertainty the model can reason about.

This is enforced at two levels:

1. `fitToBudget` records every dropped feature, aggregated per layer.
2. `emitAndVerify` re-measures the *real* emitted output and keeps cutting until
   it fits, so the reported budget is the budget actually delivered.

A name the agent can see but cannot route to is treated as a defect, not a
feature. Landmarks are attached to the network during compilation, and the
budgeter refuses to strand one. If a landmark would end up unreachable, it is
removed rather than shipped.

---

## 5. Prompting an agent

supercarto does not require a custom system prompt, but if you want the model to
use the graph well, this is the useful part:

```text
You receive map data as a YAML graph.

- `nodes` are places. Named nodes are real places; unnamed intersections are
  only junctions.
- `edges` are walkable connections. `dist` is metres, `dir` is the compass
  direction of travel from the first node to the second, `path` is the kind of
  way (sidewalk, road, stairs, access).
- An edge with `blocked: true` cannot be used.
- If `omitted` is present the map is incomplete. Say so rather than concluding
  a missing feature does not exist.
- For exact geometry beyond this summary, call the tools listed under `tools`.
  Do not guess coordinates.
```

That is about 90 tokens. The point is that it describes *semantics*, not
syntax, because the syntax is standard YAML the model already knows.

---

## 6. When to reach for raw geometry

The graph is the right default, but it is lossy by design. When a task needs
exact shape - checking whether a drone clears a roofline, computing a
footprint's area - pass WKT or SVG instead, in a `geometry:` block:

```yaml
geometry:
  n6_footprint: "POLYGON((100 100, 300 100, 300 300, 100 300, 100 100))"
  n3_to_n5_path: "M 0 0 L 120 0 L 210 65"
```

Both formats are things the model has seen extensively in pre-training, so
neither requires explanation. `expand_feature(id)` on a server holding the SCR
document is the intended way to fetch these.
