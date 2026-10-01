# SCR — SuperCarto 1

**Status:** draft spec, v1.0
**MIME (text):** `application/vnd.supercarto.text`
**MIME (binary, planned):** `application/vnd.supercarto.binary+zstd`

---

## 0. What SCR is for

SCR is a **transport format**. It is optimized for machines and networks, not for
language models. It exists so that a map backend can ship a location cheaply and
deterministically, and so that supercarto can compile that into an LLM-native
reasoning format.

SCR is **never** meant to be placed in a prompt directly. See
[§9 "Why SCR is not the reasoning format"](#9-why-scr-is-not-the-reasoning-format).

Design goals, in priority order:

1. **Token-efficient.** Integers, delta encoding, and dictionaries. No repeated keys.
2. **Line-oriented.** One record per line, whitespace-separated. Trivially parseable
   by a deterministic parser, and readable when a human has to debug it.
3. **Lossless round-trip.** `decode(encode(x)) === x` for every feature geometry.
4. **Self-describing omission.** The format must always say what it dropped.
5. **Externally referable.** Heavy payloads are referenced by URI, never inlined.

---

## 1. Lexical structure

A SCR document is UTF-8 text. Lines are separated by `\n`. A leading `#` begins a
comment that runs to end of line. Blank lines are insignificant.

A document is a sequence of **records**. A record is a **tag** (one or more
uppercase letters) followed by a space and a list of **fields** separated by
single spaces.

```
<tag> <field> <field> ...
```

Field grammar:

| Kind | Syntax | Example |
|---|---|---|
| unsigned integer | `0` or `[1-9][0-9]*` | `4096` |
| signed integer | `-?` + digits | `-37` |
| number | integer or float | `18.5`, `1e3` |
| token | non-space run | `road.primary` |
| string | rest of line after the field index | `Blue Bottle Coffee` |
| coord list | `x,y` pairs joined by `;` | `10,20;30,40` |
| paths | coord lists joined by `\|` | `10,20;30,40\|1,2;3,4` |

Notes:

- Integer values are the default for coordinates. Real-valued coordinates are
  permitted only in `BBOX` and `META`, never in geometry.
- A `string` field is always last on its record. This is why `S` records can hold
  spaces and how attribute values with spaces work.
- There are no quoting rules and no escape character. A `string` cannot contain
  a newline. This is a deliberate trade: it costs a sanitization step on ingest
  and buys a parser that is a single `split(' ')` in any language.

---

## 2. Document structure

```text
SCR 1
<envelope>
<projection + quantization>
<metadata>
<layers>
<classes>
<string dictionary>
<attribute sets>
<features>
<heat layers>
<omissions>
<references>
<routes>
```

Order is normative: a decoder may read records in a single forward pass without
backtracking, and a writer may emit top-down. Records of the same tag may be
interleaved. A decoder **must** tolerate any record appearing in any order after
the header, but a writer **must** follow the order above.

---

## 3. Header

```text
SCR 1
```

`SCR` is the magic. The integer is the major spec version. A decoder **must**
reject a major version it does not implement.

---

## 4. Envelope

Exactly one envelope record is **required**.

### 4.1 `TILE` — Web Mercator slippy tile

```text
TILE <z> <x> <y>
TILE 15 5240 12661
```

Z-order standard XYZ, top-left origin, `0 <= x,y < 2^z`.

### 4.2 `BBOX` — WGS84 bounding box

```text
BBOX <west> <south> <east> <north>
BBOX -122.412 37.772 -122.408 37.776
```

`west` may exceed `east` when the envelope crosses the antimeridian. Latitudes
are clamped to `[-85.0511, 85.0511]` in projection (§5).

`BBOX` is the ad-hoc form. `TILE` is preferred for production because tiles are
cacheable and globally uniform. A document may use `BBOX` without a projection
record, in which case the default projection (§5) and quantization apply.

---

## 5. Projection and quantization

```text
PROJ <name> <param>...
Q <extent>
BUF <n>
```

| Projection | Params | Meaning |
|---|---|---|
| `webmerc` | *(none)* | EPSG:3857. The default. |
| `wgs84` | *(none)* | EPSG:4326, degrees as fixed-point. |

`Q <extent>` declares the integer grid resolution across the envelope. Default
`4096`. This is the MVT idea: coordinates are integers, so they tokenize cheaply
and are unambiguous.

Valid coordinate range is `-BUF .. (Q + BUF)`. Without a `BUF` record the range
is `0 .. Q`. The buffer exists so that a road or polygon crossing the envelope
edge can be clipped without inventing new vertices.

```text
Q 4096
BUF 64
```

---

## 6. Dictionary records

### 6.1 `L` — layer

```text
L <id> <name>
L 1 road
```

A layer is a semantic group of classes. Layer ids are dense integers starting at
`1`, and **must** be declared before any class or feature references them.

### 6.2 `C` — class

```text
C <id> <layer_id> <class_name>
C 1 1 road.primary
```

A class is a type within a layer. Class names are dot-namespaced and SHOULD match
an OSM `value` where one exists (`road.primary`, `amenity.cafe`).

### 6.3 `S` — string dictionary

```text
S <id> <text>
S 20 Blue Bottle Coffee
```

Everything after the id is the literal text, including spaces. The low ids
(`1`–`99`) are reserved for **attribute keys**; ids `>= 100` are for **values**.
This split is a convention that makes a decoded attribute set self-describing
without a schema, and it is the main reason a document stays small: a key like
`opening_hours` is written once and referenced by number thereafter.

```text
S 10 name
S 11 opening_hours
S 100 Blue Bottle Coffee
A 3 10=s100;11=1101
```

### 6.4 `A` — attribute set

```text
A <id> <prop>;<prop>;...
A 3 10=s100;11=1101
A 4 12=18
```

A property is `<key>=<value>`:

- `key` is a string-dictionary id.
- A value of the form `s<digits>` is a **string reference** to string id `<digits>`.
- Any other value is a **literal** number, boolean (`true`/`false`), or bare token.

Attribute sets are deduplicated: 500 features sharing `name` and `type` share one
`A` record. This is where most of the token savings over GeoJSON come from.

`A` id `0` is reserved to mean *no attributes*, and is never emitted.

---

## 7. Features

```text
F <id> <layer_id> <class_id> <geom_kind> <attr_set_id> <geometry>
```

| `geom_kind` | Meaning |
|---|---|
| `P` | point |
| `L` | line, or multiline |
| `G` | polygon, or multipolygon (exterior + holes) |
| `B` | building footprint, a polygon extruded by its attributes |

Example:

```text
F 1 1 1 L 1 d:0,2048,4096,0
F 2 2 3 P 3 2100,2150
F 3 3 4 B 4 100,100;300,100;300,300;100,300
F 4 1 1 L 0 0,1000;4096,1000
```

### 7.1 Geometry payload

The payload is either a **path list** or a **delta path list**.

Absolute:

```text
100,100;300,100;300,300;100,300
```

Delta, prefixed with `d:`:

```text
d:0,2048,4096,0
```

Delta semantics: the first pair is absolute; each subsequent pair is a
**displacement** applied to the previous vertex. Encoding is `(dx, dy)` per
vertex after the first. Deltas are the default for lines and polygons because
consecutive map vertices are close, so deltas are small and small integers are
cheap. A decoder **must** support both forms regardless of tag.

For `G` and `B`, multiple rings are joined by `|`. The first ring of each part is
the exterior; subsequent rings are holes.

```text
G 0,0;400,0;400,400;0,400|100,100;200,100;200,200;100,200
```

Rings are implicitly closed — a writer **must not** repeat the first vertex as
the last, and a decoder **must** close them. Multiple *parts* (multipolygon) are
encoded as a `|`-joined sequence of ring groups, separated by an extra `|`:

```text
G ext1|hole1|ext2|hole2
```

To disambiguate, supercarto uses a dedicated group separator rather than asking
the decoder to infer parts from winding order:

```text
G ext1|hole1 || ext2|hole2
```

The `||` token separates polygon parts. This is a supercarto extension over the
`AM1` draft it derives from, and it removes all ambiguity about part grouping.

### 7.2 Altitude

A point may carry `z`:

```text
P 2048,2100,12
```

`z` is in metres above the local ellipsoid, quantized to whole metres. Lines,
polygons, and buildings carry no `z`; building height arrives as an attribute
(`height_m`), which is what a reasoning layer actually wants.

---

## 8. Heat layers

A heat layer declares a scalar field over the envelope.

```text
H <id> <name> <resolution> <min_value> <max_value>
H 1 crowd_density 64 0 255
```

`resolution` is the grid edge length. The field is `resolution` by `resolution`
cells, addressed by integer cell coordinates, not pixel coordinates.

Three encodings, chosen by sparsity:

### 8.1 `X` — sparse points

```text
X 1 32,18,92;40,22,88
```

Best when only a few hotspots matter. This is the default choice, because a
reasoning layer reasons about *hotspots*, not about fields.

### 8.2 `D` — run-length rows

```text
D 1 12 10,5,200;30,2,80
```

Row `12`, columns `10..14` = `200`, columns `30..31` = `80`. Best for wide
bands of uniform value, e.g. flood extent or a wall of noise.

### 8.3 `HC` — cell-indexed

```text
HC 2 8a28308280fffff 72
```

`HC` keys on an external index such as H3 or S2 rather than a local grid. Use
for anything spanning multiple documents, where a local grid has no meaning.
The hex cell id is a single token and does not need to be in the string
dictionary.

---

## 9. Omission records

```text
O <layer_id> <count> [centroid=x,y] [note=<string_id>]
O 3 137 centroid=2048,2048
O 2 43 centroid=2048,2048 note=1042
```

An omission record is how the format stays honest under a token budget. **Every**
budgeted document that drops a feature **must** emit one. An agent that is told
"the map is partial, 137 buildings were dropped, concentrated in the centre" can
reason about what it does not know. An agent handed a silently-truncated map
cannot.

This is the single most important record type in SCR. A format that lies about
its own completeness produces confident, wrong navigation.

---

## 10. References

```text
REF <kind> <uri> [mime=<mime>] [note=<string_id>]
REF buildings scr://tile/15/5240/12661/buildings.bin mime=application/vnd.supercarto.binary
```

A reference points at a payload too large to inline: full binary geometry,
terrain meshes, navigation graphs, imagery. The scheme is `scr://`. A resolver
may translate it to HTTP, `file://`, or object storage.

`kind` is a bare token: `buildings`, `terrain`, `mesh`, `graph`, `imagery`,
`elevation`.

---

## 11. Routes

```text
ROUTE <id> <mode> [dist=<meters>] [time=<seconds>]
ROUTE 1 walk dist=840 time=610
STEP <n> <instruction> [dist=<meters>] [ref=<string_id>] [turn=<token>]
STEP 1 head east on Mission Street 120
STEP 2 turn left on 5th Street 90
```

A route is deliberately **two** representations: `STEP` records for the model,
and a `REF route <uri>` pointing at full geometry for code.

The transcript's premise holds: for a language model, `turn left on 5th Street`
is worth more than four hundred coordinates. Instructions are prose because the
model was trained on prose, and prose is the cheapest thing it can read.

---

## 12. Metadata

```text
META <key> <value>
META source osm
META date 2026-09-17
META simplification high
```

Free-form provenance and provenance-adjacent scalars. Keys are unnamespaced by
convention; recommended keys are listed in [§14](#14-reserved-meta-keys).

---

## 13. Complete example

```text
SCR 1
TILE 15 5240 12661
Q 4096
BUF 64
META source osm
META date 2026-09-17

L 1 road
L 2 poi
L 3 building

C 1 1 road.primary
C 2 1 road.secondary
C 3 2 amenity.cafe
C 4 3 building.commercial

S 10 name
S 11 amenity
S 12 height_m
S 100 Mission Street
S 101 Oak Street
S 102 Blue Bottle Coffee
S 103 cafe
S 104 24 Market St

A 1 10=s100
A 2 10=s101
A 3 10=s102;11=s103
A 4 10=s104
A 5 12=18
A 6 12=24

F 1 1 1 L 1 d:0,2048,4096,0
F 2 1 2 L 2 d:2048,0,0,4096
F 3 2 3 P 3 2100,2150
F 4 3 4 B 5 100,100;300,100;300,300;100,300
F 5 3 4 B 6 500,500;800,500;800,900;500,900

H 1 crowd_density 64 0 255
X 1 32,18,92;40,22,88

O 3 137 centroid=2048,2048

REF buildings scr://tile/15/5240/12661/buildings.bin mime=application/vnd.supercarto.binary
```

---

## 14. Reserved `META` keys

| Key | Meaning |
|---|---|
| `source` | Provenance: `osm`, `overture`, `protomaps`, `pmtiles`, `custom`. |
| `date` | ISO-8601 date of the underlying data. |
| `simplification` | `none`, `low`, `medium`, `high`. |
| `budget_tokens` | The token budget this document was compiled to. |
| `omitted_total` | Sum of all `O` counts, for a cheap completeness check. |
| `lod` | The semantic zoom band, e.g. `z15-block`. |

---

## 15. Why SCR is not the reasoning format

The fatal flaw of any invented syntax is that a model was not trained on it. A
novel compressed grammar in a context window produces hallucinated coordinates
and burned tokens spent inferring the grammar.

So supercarto keeps the two concerns strictly apart:

- **SCR is the wire format.** Compiled, streamed, and zstd'd by machines.
- **The reasoning format is YAML.** A topological graph in flow style, using only
  constructs a model has read billions of times.

The agent never sees SCR. A deterministic compiler in the middleware does the
translation. See `docs/reasoning-format.md`.

---

## 16. Conformance

A conforming implementation **must**:

1. Reject an unknown major version.
2. Preserve every vertex through a round trip (quantization is lossy in the
   reals; the round trip is exact in the quantized integers).
3. Support both absolute and delta geometry payloads.
4. Emit omission records for every dropped feature under a budget.
5. Never emit a bare token as a string-dictionary value that a `s`-reference
   would have disambiguated.

A conforming implementation **should**:

1. Emit delta geometry for `L`, `G`, and `B`.
2. Emit absolute geometry for `P`, where delta buys little and readability
   costs nothing.
3. Reserve string ids `1`–`99` for attribute keys.
