var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// ../../src/wire/types.ts
var DEFAULT_EXTENT = 4096;
var DEFAULT_PROJECTION = "webmerc";
var SCR_MAGIC = "SCR";

// ../../src/wire/errors.ts
var ScrError = class extends Error {
  static {
    __name(this, "ScrError");
  }
  name = "ScrError";
  /** 1-based line number, when known. */
  line;
  constructor(message, line) {
    super(line === void 0 ? message : `line ${line}: ${message}`);
    this.line = line;
  }
};

// ../../src/wire/geometry.ts
var PART_SEPARATOR = "||";
var RING_SEPARATOR = "|";
var VERTEX_SEPARATOR = ";";
var DELTA_PREFIX = "d:";
function encodePath(line) {
  let out = "";
  for (let i = 0; i < line.length; i++) {
    const p = line[i];
    if (i > 0) out += VERTEX_SEPARATOR;
    out += `${p.x},${p.y}`;
  }
  return out;
}
__name(encodePath, "encodePath");
function encodeDeltaPath(line) {
  if (line.length === 0) return "";
  const parts = [];
  const first = line[0];
  parts.push(`${first.x},${first.y}`);
  for (let i = 1; i < line.length; i++) {
    const prev = line[i - 1];
    const cur = line[i];
    parts.push(`${cur.x - prev.x},${cur.y - prev.y}`);
  }
  return DELTA_PREFIX + parts.join(",");
}
__name(encodeDeltaPath, "encodeDeltaPath");
function decodePath(text) {
  if (text === "") return [];
  const out = [];
  for (const chunk of text.split(VERTEX_SEPARATOR)) {
    if (chunk === "") continue;
    out.push(parsePoint(chunk));
  }
  return out;
}
__name(decodePath, "decodePath");
function decodeDeltaPath(text) {
  const body = text.slice(DELTA_PREFIX.length);
  if (body === "") return [];
  const nums = body.split(",").filter((s) => s !== "");
  if (nums.length < 2) {
    throw new ScrError(`delta path needs at least one vertex, got "${text}"`);
  }
  if (nums.length % 2 !== 0) {
    throw new ScrError(`delta path has odd coordinate count in "${text}"`);
  }
  let x = int(nums[0]);
  let y = int(nums[1]);
  const out = [{ x, y }];
  for (let i = 2; i < nums.length; i += 2) {
    x += int(nums[i]);
    y += int(nums[i + 1]);
    out.push({ x, y });
  }
  return out;
}
__name(decodeDeltaPath, "decodeDeltaPath");
function decodePathAuto(text) {
  return text.startsWith(DELTA_PREFIX) ? decodeDeltaPath(text) : decodePath(text);
}
__name(decodePathAuto, "decodePathAuto");
function encodePathSmart(line) {
  return line.length >= 4 ? encodeDeltaPath(line) : encodePath(line);
}
__name(encodePathSmart, "encodePathSmart");
function encodePolygon(polygon) {
  return polygon.map((part) => part.rings.map(encodePathSmart).join(RING_SEPARATOR)).join(PART_SEPARATOR);
}
__name(encodePolygon, "encodePolygon");
function decodePolygon(text) {
  if (text === "") return [];
  const parts = [];
  for (const partText of text.split(PART_SEPARATOR)) {
    const rings = partText.split(RING_SEPARATOR).filter((r) => r !== "").map((r) => decodePathAuto(r));
    if (rings.length > 0) parts.push({ rings });
  }
  return parts;
}
__name(decodePolygon, "decodePolygon");
function encodePoint(p) {
  return p.z === void 0 ? `${p.x},${p.y}` : `${p.x},${p.y},${p.z}`;
}
__name(encodePoint, "encodePoint");
function parsePoint(chunk) {
  const parts = chunk.split(",");
  if (parts.length < 2) throw new ScrError(`malformed point "${chunk}"`);
  const p = { x: int(parts[0]), y: int(parts[1]) };
  if (parts.length >= 3 && parts[2] !== "") p.z = int(parts[2]);
  return p;
}
__name(parsePoint, "parsePoint");
function encodeSparseHeat(h) {
  const cells = h.cells ?? [];
  const body = cells.map((c) => `${c.x},${c.y},${c.value}`).join(VERTEX_SEPARATOR);
  return body === "" ? [] : [`X ${h.id} ${body}`];
}
__name(encodeSparseHeat, "encodeSparseHeat");
function encodeRleHeat(h) {
  const rows = h.rows ?? [];
  const out = [];
  for (const row of rows) {
    if (row.runs.length === 0) continue;
    const body = row.runs.map((r) => `${r.x},${r.len},${r.value}`).join(VERTEX_SEPARATOR);
    out.push(`D ${h.id} ${row.y} ${body}`);
  }
  return out;
}
__name(encodeRleHeat, "encodeRleHeat");
function encodeIndexedHeat(h) {
  return (h.indexed ?? []).map((c) => `HC ${h.id} ${c.cell} ${c.value}`);
}
__name(encodeIndexedHeat, "encodeIndexedHeat");
function encodeHeatBody(h) {
  switch (h.encoding) {
    case "rle":
      return encodeRleHeat(h);
    case "cell":
      return encodeIndexedHeat(h);
    case "sparse":
    default:
      return encodeSparseHeat(h);
  }
}
__name(encodeHeatBody, "encodeHeatBody");
function decodeSparseCells(text) {
  const out = [];
  for (const chunk of text.split(VERTEX_SEPARATOR)) {
    if (chunk === "") continue;
    const parts = chunk.split(",");
    if (parts.length < 3) throw new ScrError(`malformed heat cell "${chunk}"`);
    out.push({ x: int(parts[0]), y: int(parts[1]), value: num(parts[2]) });
  }
  return out;
}
__name(decodeSparseCells, "decodeSparseCells");
function decodeRleRuns(text) {
  const out = [];
  for (const chunk of text.split(VERTEX_SEPARATOR)) {
    if (chunk === "") continue;
    const parts = chunk.split(",");
    if (parts.length < 3) throw new ScrError(`malformed heat run "${chunk}"`);
    out.push({ x: int(parts[0]), len: int(parts[1]), value: num(parts[2]) });
  }
  return out;
}
__name(decodeRleRuns, "decodeRleRuns");
function encodeProps(props) {
  return props.map((p) => {
    const v = p.value;
    let rendered;
    switch (v.t) {
      case "ref":
        rendered = `s${v.ref}`;
        break;
      case "num":
        rendered = String(v.num);
        break;
      case "bool":
        rendered = v.bool ? "true" : "false";
        break;
      case "token":
        rendered = v.token;
        break;
    }
    return `${p.key}=${rendered}`;
  }).join(VERTEX_SEPARATOR);
}
__name(encodeProps, "encodeProps");
function decodeProps(text) {
  if (text === "" || text === "0") return [];
  const out = [];
  for (const chunk of text.split(VERTEX_SEPARATOR)) {
    if (chunk === "") continue;
    const eq = chunk.indexOf("=");
    if (eq < 0) throw new ScrError(`malformed property "${chunk}"`);
    const key = int(chunk.slice(0, eq));
    const raw = chunk.slice(eq + 1);
    out.push({ key, value: parseAttrValue(raw) });
  }
  return out;
}
__name(decodeProps, "decodeProps");
function parseAttrValue(raw) {
  if (/^s\d+$/.test(raw)) return { t: "ref", ref: int(raw.slice(1)) };
  if (raw === "true") return { t: "bool", bool: true };
  if (raw === "false") return { t: "bool", bool: false };
  if (/^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(raw)) return { t: "num", num: Number(raw) };
  return { t: "token", token: raw };
}
__name(parseAttrValue, "parseAttrValue");
function int(text) {
  if (!/^-?\d+$/.test(text)) throw new ScrError(`expected integer, got "${text}"`);
  return Number(text);
}
__name(int, "int");
function num(text) {
  const n = Number(text);
  if (!Number.isFinite(n)) throw new ScrError(`expected number, got "${text}"`);
  return n;
}
__name(num, "num");

// ../../src/wire/encode.ts
function encodeDocument(doc, opts = {}) {
  const group = opts.group ?? true;
  const out = [];
  const nl = /* @__PURE__ */ __name((s = "") => out.push(s), "nl");
  const gap = /* @__PURE__ */ __name(() => {
    if (group && out.length > 0 && out[out.length - 1] !== "") out.push("");
  }, "gap");
  nl(`${SCR_MAGIC} ${doc.version}`);
  nl(encodeEnvelope(doc.envelope));
  if (doc.projection !== DEFAULT_PROJECTION) nl(`PROJ ${doc.projection}`);
  nl(`Q ${doc.extent}`);
  if (doc.buffer) nl(`BUF ${doc.buffer}`);
  if (Object.keys(doc.meta).length > 0) {
    gap();
    for (const key of orderedKeys(doc.meta)) nl(`META ${key} ${doc.meta[key]}`);
  }
  if (doc.layers.size > 0) {
    gap();
    for (const layer of sorted(doc.layers.values())) nl(`L ${layer.id} ${layer.name}`);
  }
  if (doc.classes.size > 0) {
    gap();
    for (const c of sorted(doc.classes.values())) nl(`C ${c.id} ${c.layerId} ${c.name}`);
  }
  if (doc.strings.size > 0) {
    gap();
    for (const [id, text] of sorted(doc.strings.entries())) nl(`S ${id} ${text}`);
  }
  if (doc.attrSets.size > 0) {
    gap();
    for (const a of sorted(doc.attrSets.values())) nl(`A ${a.id} ${encodeProps(a.props)}`);
  }
  if (doc.features.length > 0) {
    gap();
    for (const f of doc.features) nl(encodeFeature(f));
  }
  if (doc.heat.length > 0) {
    gap();
    for (const h of doc.heat) {
      nl(`H ${h.id} ${h.name} ${h.resolution} ${h.minValue} ${h.maxValue}`);
      for (const line of encodeHeatBody(h)) nl(line);
    }
  }
  if (doc.omissions.length > 0) {
    gap();
    for (const o of doc.omissions) nl(encodeOmission(o));
  }
  if (doc.refs.length > 0) {
    gap();
    for (const r of doc.refs) nl(encodeRef(r));
  }
  for (const route of doc.routes) {
    gap();
    nl(encodeRouteHeader(route));
    for (const step of route.steps) nl(encodeStep(step));
  }
  return out.join("\n") + "\n";
}
__name(encodeDocument, "encodeDocument");
function encodeEnvelope(env) {
  return env.type === "tile" ? `TILE ${env.z} ${env.x} ${env.y}` : `BBOX ${env.west} ${env.south} ${env.east} ${env.north}`;
}
__name(encodeEnvelope, "encodeEnvelope");
function encodeFeature(f) {
  const payload = encodeGeometryPayload(f);
  return `F ${f.id} ${f.layerId} ${f.classId} ${geomKindTag(f.kind)} ${f.attrSet} ${payload}`;
}
__name(encodeFeature, "encodeFeature");
function geomKindTag(kind) {
  switch (kind) {
    case "point":
      return "P";
    case "line":
      return "L";
    case "polygon":
      return "G";
    case "building":
      return "B";
  }
}
__name(geomKindTag, "geomKindTag");
function encodeGeometryPayload(f) {
  const g = f.geometry;
  switch (g.kind) {
    case "point":
      return encodePoint(g.point);
    case "line":
      return g.lines.map(encodePathSmart).join("|");
    case "polygon":
    case "building":
      return encodePolygon(g.polygon);
  }
}
__name(encodeGeometryPayload, "encodeGeometryPayload");
function encodeOmission(o) {
  let line = `O ${o.layerId} ${o.count}`;
  if (o.centroid) line += ` centroid=${o.centroid.x},${o.centroid.y}`;
  if (o.note !== void 0) line += ` note=${o.note}`;
  return line;
}
__name(encodeOmission, "encodeOmission");
function encodeRef(r) {
  let line = `REF ${r.kind} ${r.uri}`;
  if (r.mime) line += ` mime=${r.mime}`;
  if (r.note !== void 0) line += ` note=${r.note}`;
  return line;
}
__name(encodeRef, "encodeRef");
function encodeRouteHeader(r) {
  let line = `ROUTE ${r.id} ${r.mode}`;
  if (r.dist !== void 0) line += ` dist=${r.dist}`;
  if (r.time !== void 0) line += ` time=${r.time}`;
  return line;
}
__name(encodeRouteHeader, "encodeRouteHeader");
function encodeStep(s) {
  const kv = [];
  if (s.dist !== void 0) kv.push(`dist=${s.dist}`);
  if (s.ref !== void 0) kv.push(`ref=${s.ref}`);
  if (s.turn !== void 0) kv.push(`turn=${s.turn}`);
  return `STEP ${s.n} ${kv.length > 0 ? kv.join(" ") + " " : ""}${s.instruction}`;
}
__name(encodeStep, "encodeStep");
function orderedKeys(record) {
  return Object.keys(record).sort();
}
__name(orderedKeys, "orderedKeys");
function sorted(iterable) {
  return [...iterable].sort((a, b) => compareIds(a, b));
}
__name(sorted, "sorted");
function compareIds(a, b) {
  const av = idOf(a);
  const bv = idOf(b);
  if (typeof av === "number" && typeof bv === "number") return av - bv;
  return String(av) < String(bv) ? -1 : String(av) > String(bv) ? 1 : 0;
}
__name(compareIds, "compareIds");
function idOf(x) {
  if (x && typeof x === "object" && "id" in x) {
    const id = x.id;
    if (typeof id === "number") return id;
    if (typeof id === "string") return id;
  }
  return String(x);
}
__name(idOf, "idOf");

// ../../src/wire/decode.ts
function decodeDocument(text, opts = {}) {
  const maxFeatures = opts.maxFeatures ?? 5e6;
  const lines = text.split("\n");
  const doc = {
    version: 1,
    envelope: { type: "tile", z: 0, x: 0, y: 0 },
    projection: DEFAULT_PROJECTION,
    extent: DEFAULT_EXTENT,
    buffer: 0,
    meta: {},
    layers: /* @__PURE__ */ new Map(),
    classes: /* @__PURE__ */ new Map(),
    strings: /* @__PURE__ */ new Map(),
    attrSets: /* @__PURE__ */ new Map(),
    features: [],
    heat: [],
    omissions: [],
    refs: [],
    routes: []
  };
  let sawHeader = false;
  let sawEnvelope = false;
  let sawQ = false;
  const heatById = /* @__PURE__ */ new Map();
  const routeById = /* @__PURE__ */ new Map();
  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const raw = lines[i];
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const sp = line.indexOf(" ");
    const tag = sp < 0 ? line : line.slice(0, sp);
    const rest = sp < 0 ? "" : line.slice(sp + 1).trim();
    if (!sawHeader) {
      if (tag !== SCR_MAGIC) throw new ScrError(`expected "${SCR_MAGIC}" header, got "${tag}"`, lineNo);
      const version = int(rest);
      if (version !== 1) {
        throw new ScrError(`unsupported SCR major version ${version}`, lineNo);
      }
      doc.version = version;
      sawHeader = true;
      continue;
    }
    switch (tag) {
      case "TILE": {
        const f = fields(rest, 3, "TILE", lineNo);
        doc.envelope = { type: "tile", z: int(f[0]), x: int(f[1]), y: int(f[2]) };
        sawEnvelope = true;
        break;
      }
      case "BBOX": {
        const f = fields(rest, 4, "BBOX", lineNo);
        doc.envelope = {
          type: "bbox",
          west: num(f[0]),
          south: num(f[1]),
          east: num(f[2]),
          north: num(f[3])
        };
        sawEnvelope = true;
        break;
      }
      case "PROJ": {
        const name = fields(rest, 1, "PROJ", lineNo)[0];
        if (name !== "webmerc" && name !== "wgs84") {
          throw new ScrError(`unknown projection "${name}"`, lineNo);
        }
        doc.projection = name;
        break;
      }
      case "Q": {
        doc.extent = int(fields(rest, 1, "Q", lineNo)[0]);
        sawQ = true;
        break;
      }
      case "BUF":
        doc.buffer = int(fields(rest, 1, "BUF", lineNo)[0]);
        break;
      case "META": {
        const f = fields(rest, 2, "META", lineNo);
        doc.meta[f[0]] = f.slice(1).join(" ");
        break;
      }
      case "L": {
        const f = fields(rest, 2, "L", lineNo);
        const layer = { id: int(f[0]), name: f.slice(1).join(" ") };
        doc.layers.set(layer.id, layer);
        break;
      }
      case "C": {
        const f = fields(rest, 3, "C", lineNo);
        const cls = { id: int(f[0]), layerId: int(f[1]), name: f.slice(2).join(" ") };
        doc.classes.set(cls.id, cls);
        break;
      }
      case "S": {
        const sp2 = rest.indexOf(" ");
        if (sp2 < 0) throw new ScrError("S record needs text", lineNo);
        const id = int(rest.slice(0, sp2));
        doc.strings.set(id, rest.slice(sp2 + 1));
        break;
      }
      case "A": {
        const f = fields(rest, 2, "A", lineNo);
        const set = { id: int(f[0]), props: decodeProps(f[1]) };
        doc.attrSets.set(set.id, set);
        break;
      }
      case "F": {
        if (doc.features.length >= maxFeatures) {
          throw new ScrError(`feature count exceeds maxFeatures (${maxFeatures})`, lineNo);
        }
        doc.features.push(decodeFeature(rest, lineNo));
        break;
      }
      case "H": {
        const f = fields(rest, 5, "H", lineNo);
        const layer = {
          id: int(f[0]),
          name: f[1],
          resolution: int(f[2]),
          minValue: num(f[3]),
          maxValue: num(f[4]),
          encoding: "sparse",
          cells: []
        };
        heatById.set(layer.id, layer);
        doc.heat.push(layer);
        break;
      }
      case "D": {
        const f = fields(rest, 3, "D", lineNo);
        const h = requireHeat(heatById, int(f[0]), lineNo);
        h.encoding = "rle";
        (h.rows ??= []).push({ y: int(f[1]), runs: decodeRleRuns(f[2]) });
        break;
      }
      case "X": {
        const f = fields(rest, 2, "X", lineNo);
        const h = requireHeat(heatById, int(f[0]), lineNo);
        h.encoding = "sparse";
        (h.cells ??= []).push(...decodeSparseCells(f[1]));
        break;
      }
      case "HC": {
        const f = fields(rest, 3, "HC", lineNo);
        const h = requireHeat(heatById, int(f[0]), lineNo);
        h.encoding = "cell";
        (h.indexed ??= []).push({ cell: f[1], value: num(f[2]) });
        break;
      }
      case "O": {
        const f = fields(rest, 2, "O", lineNo);
        const omission = { layerId: int(f[0]), count: int(f[1]) };
        for (const tok of f.slice(2)) {
          const eq = tok.indexOf("=");
          if (eq < 0) throw new ScrError(`malformed O option "${tok}"`, lineNo);
          const k = tok.slice(0, eq);
          const v = tok.slice(eq + 1);
          if (k === "centroid") {
            const c = v.split(",");
            omission.centroid = { x: int(c[0]), y: int(c[1]) };
          } else if (k === "note") {
            omission.note = int(v);
          } else {
            throw new ScrError(`unknown O option "${k}"`, lineNo);
          }
        }
        doc.omissions.push(omission);
        break;
      }
      case "REF": {
        const f = fields(rest, 2, "REF", lineNo);
        const ref = { kind: f[0], uri: f[1] };
        for (const tok of f.slice(2)) {
          const eq = tok.indexOf("=");
          if (eq < 0) throw new ScrError(`malformed REF option "${tok}"`, lineNo);
          const k = tok.slice(0, eq);
          const v = tok.slice(eq + 1);
          if (k === "mime") ref.mime = v;
          else if (k === "note") ref.note = int(v);
          else throw new ScrError(`unknown REF option "${k}"`, lineNo);
        }
        doc.refs.push(ref);
        break;
      }
      case "ROUTE": {
        const f = fields(rest, 2, "ROUTE", lineNo);
        const route = { id: int(f[0]), mode: f[1], steps: [] };
        for (const tok of f.slice(2)) {
          const eq = tok.indexOf("=");
          if (eq < 0) throw new ScrError(`malformed ROUTE option "${tok}"`, lineNo);
          const k = tok.slice(0, eq);
          const v = tok.slice(eq + 1);
          if (k === "dist") route.dist = int(v);
          else if (k === "time") route.time = int(v);
          else throw new ScrError(`unknown ROUTE option "${k}"`, lineNo);
        }
        routeById.set(route.id, route);
        doc.routes.push(route);
        break;
      }
      case "STEP": {
        const sp3 = rest.indexOf(" ");
        if (sp3 < 0) throw new ScrError("STEP record needs an instruction", lineNo);
        const n = int(rest.slice(0, sp3));
        const step = { n, instruction: "" };
        const tail = rest.slice(sp3 + 1);
        let consumed = 0;
        for (; ; ) {
          const m = /^(dist|ref|turn)=(\S+)\s*/.exec(tail.slice(consumed));
          if (!m) break;
          const k = m[1];
          const v = m[2];
          if (k === "dist") step.dist = int(v);
          else if (k === "ref") step.ref = int(v);
          else step.turn = v;
          consumed += m[0].length;
        }
        step.instruction = tail.slice(consumed).trim();
        if (step.instruction === "") throw new ScrError("STEP instruction is empty", lineNo);
        const route = lastRoute(routeById, lineNo);
        route.steps.push(step);
        break;
      }
      default:
        throw new ScrError(`unknown record tag "${tag}"`, lineNo);
    }
  }
  if (!sawHeader) throw new ScrError("empty document: missing SCR header");
  if (!sawEnvelope) throw new ScrError("missing envelope: need TILE or BBOX");
  if (!sawQ) throw new ScrError("missing Q record: quantization extent is required");
  return doc;
}
__name(decodeDocument, "decodeDocument");
function fields(rest, count, tag, lineNo) {
  const parts = rest.length === 0 ? [] : rest.split(" ");
  if (parts.length < count) {
    throw new ScrError(`${tag} needs ${count} fields, got ${parts.length}`, lineNo);
  }
  return parts;
}
__name(fields, "fields");
function requireHeat(byId, id, lineNo) {
  const h = byId.get(id);
  if (!h) throw new ScrError(`heat record references undeclared layer ${id}`, lineNo);
  return h;
}
__name(requireHeat, "requireHeat");
function lastRoute(byId, lineNo) {
  let last;
  for (const r of byId.values()) last = r;
  if (!last) throw new ScrError("STEP record before any ROUTE record", lineNo);
  return last;
}
__name(lastRoute, "lastRoute");
function decodeFeature(rest, lineNo) {
  const f = fields(rest, 6, "F", lineNo);
  const id = int(f[0]);
  const layerId = int(f[1]);
  const classId = int(f[2]);
  const kind = decodeGeomKind(f[3], lineNo);
  const attrSet = int(f[4]);
  const payload = f.slice(5).join(" ");
  return { id, layerId, classId, kind, attrSet, geometry: decodeGeometry(kind, payload) };
}
__name(decodeFeature, "decodeFeature");
function decodeGeomKind(tag, lineNo) {
  switch (tag) {
    case "P":
      return "point";
    case "L":
      return "line";
    case "G":
      return "polygon";
    case "B":
      return "building";
    default:
      throw new ScrError(`unknown geometry kind "${tag}"`, lineNo);
  }
}
__name(decodeGeomKind, "decodeGeomKind");
function decodeGeometry(kind, payload) {
  switch (kind) {
    case "point": {
      const path = decodePath(payload);
      if (path.length === 0) throw new ScrError("point geometry is empty");
      return { kind: "point", point: path[0] };
    }
    case "line": {
      const lines = payload.split("|").filter((s) => s !== "").map(decodePathAuto);
      return { kind: "line", lines };
    }
    case "polygon":
      return { kind: "polygon", polygon: decodePolygon(payload) };
    case "building":
      return { kind: "building", polygon: decodePolygon(payload) };
  }
}
__name(decodeGeometry, "decodeGeometry");

// ../../src/geo/project.ts
var MERCATOR_MAX_LAT = 85.0511287798066;
var ORIGIN_SHIFT = 2 * Math.PI * 6378137 / 2;
var DEG = Math.PI / 180;
function lonToMercX(lon) {
  return lon * ORIGIN_SHIFT / 180;
}
__name(lonToMercX, "lonToMercX");
function latToMercY(lat) {
  const clamped = Math.max(-MERCATOR_MAX_LAT, Math.min(MERCATOR_MAX_LAT, lat));
  return Math.log(Math.tan(Math.PI / 4 + clamped * DEG / 2)) * 6378137;
}
__name(latToMercY, "latToMercY");
function mercXToLon(x) {
  return x / ORIGIN_SHIFT * 180;
}
__name(mercXToLon, "mercXToLon");
function mercYToLat(y) {
  return (2 * Math.atan(Math.exp(y / 6378137)) - Math.PI / 2) / DEG;
}
__name(mercYToLat, "mercYToLat");
function tileBounds(z, x, y) {
  const n = 2 ** z;
  const west = x / n * 360 - 180;
  const east = (x + 1) / n * 360 - 180;
  const north = mercYToLat(latToMercY(90) - latToMercY(90) * 2 * y / n);
  const south = mercYToLat(latToMercY(90) - latToMercY(90) * 2 * (y + 1) / n);
  return { west, south, east, north };
}
__name(tileBounds, "tileBounds");
function mercEnvelope(env, _projection = "webmerc") {
  if (env.type === "tile") {
    const { west, south, east, north } = tileBounds(env.z, env.x, env.y);
    return {
      minX: lonToMercX(west),
      maxX: lonToMercX(east),
      topY: latToMercY(north),
      bottomY: latToMercY(south)
    };
  }
  return {
    minX: lonToMercX(env.west),
    maxX: lonToMercX(env.east),
    topY: latToMercY(env.north),
    bottomY: latToMercY(env.south)
  };
}
__name(mercEnvelope, "mercEnvelope");
function gridToLonLat(p, env, extent, projection = "webmerc") {
  const { minX, maxX, topY, bottomY } = mercEnvelope(env, projection);
  const fx = p.x / extent;
  const fy = p.y / extent;
  const mercX = minX + fx * (maxX - minX);
  const mercY = topY + fy * (bottomY - topY);
  return { lat: mercYToLat(mercY), lon: mercXToLon(mercX) };
}
__name(gridToLonLat, "gridToLonLat");
function lonLatToGrid({ lat, lon }, env, extent, projection = "webmerc") {
  const { minX, maxX, topY, bottomY } = mercEnvelope(env, projection);
  const fx = (lonToMercX(lon) - minX) / (maxX - minX);
  const fy = (latToMercY(lat) - topY) / (bottomY - topY);
  return { x: Math.round(fx * extent), y: Math.round(fy * extent) };
}
__name(lonLatToGrid, "lonLatToGrid");

// ../../src/ingest/geojson.ts
var KEY_IDS = {
  name: 10,
  type: 11,
  height_m: 12,
  amenity: 13,
  brand: 14,
  opening_hours: 15,
  highway: 16,
  railway: 17,
  crossing: 18,
  indoor: 19,
  layer: 20,
  level: 22,
  wheelchair: 21,
  door: 23
};
var KEY_NAMES = Object.fromEntries(
  Object.entries(KEY_IDS).map(([k, v]) => [v, k])
);
var KEPT_KEYS = /* @__PURE__ */ new Map([
  ["name", KEY_IDS.name],
  ["height", KEY_IDS.height_m],
  ["height_m", KEY_IDS.height_m],
  ["building:levels", KEY_IDS.height_m],
  ["amenity", KEY_IDS.amenity],
  ["brand", KEY_IDS.brand],
  ["opening_hours", KEY_IDS.opening_hours],
  ["highway", KEY_IDS.highway],
  ["railway", KEY_IDS.railway],
  ["crossing", KEY_IDS.crossing],
  ["indoor", KEY_IDS.indoor],
  ["wheelchair", KEY_IDS.wheelchair],
  // Storey tags. Both spellings are carried because OSM uses `level` for the
  // storey and `layer` for repeat-count styling on bridges and tunnels, and an
  // indoor extractor that reads only one of them silently misses half the
  // buildings. `level` is checked first at compile time.
  ["level", KEY_IDS.level],
  ["layer", KEY_IDS.layer],
  ["door", KEY_IDS.door]
]);
var FIRST_VALUE_ID = 100;
function newAllocator() {
  const strings = /* @__PURE__ */ new Map();
  for (const [id, name] of Object.entries(KEY_NAMES)) strings.set(Number(id), name);
  return { strings, nextId: FIRST_VALUE_ID };
}
__name(newAllocator, "newAllocator");
function intern(alloc, text) {
  for (const [id2, s] of alloc.strings) {
    if (s === text) return id2;
  }
  const id = alloc.nextId++;
  alloc.strings.set(id, text);
  return id;
}
__name(intern, "intern");
function fromGeoJson(input, opts = {}) {
  const features = Array.isArray(input) ? input : input.features;
  const collectionHeat = Array.isArray(input) ? void 0 : input.heat;
  const maxFeatures = opts.maxFeatures ?? 2e5;
  const extent = opts.extent ?? DEFAULT_EXTENT;
  const buffer = opts.buffer ?? 64;
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const f of features) {
    for (const c of coordsOf(f.geometry)) {
      if (c[0] < west) west = c[0];
      if (c[1] < south) south = c[1];
      if (c[0] > east) east = c[0];
      if (c[1] > north) north = c[1];
    }
  }
  if (!Number.isFinite(west)) {
    return emptyDocument(opts, extent, buffer);
  }
  const MIN_SPAN = 1e-7;
  if (east - west < MIN_SPAN) {
    const mid = (east + west) / 2;
    west = mid - MIN_SPAN / 2;
    east = mid + MIN_SPAN / 2;
  }
  if (north - south < MIN_SPAN) {
    const mid = (north + south) / 2;
    south = mid - MIN_SPAN / 2;
    north = mid + MIN_SPAN / 2;
  }
  const envelope = opts.envelope ?? {
    type: "bbox",
    west,
    south,
    east,
    north
  };
  const doc = {
    version: 1,
    envelope,
    projection: opts.projection ?? DEFAULT_PROJECTION,
    extent,
    buffer,
    meta: { source: opts.source ?? "geojson" },
    layers: /* @__PURE__ */ new Map(),
    classes: /* @__PURE__ */ new Map(),
    strings: /* @__PURE__ */ new Map(),
    attrSets: /* @__PURE__ */ new Map(),
    features: [],
    heat: [],
    omissions: [],
    refs: [],
    routes: []
  };
  const alloc = newAllocator();
  for (const [id, name] of alloc.strings) doc.strings.set(id, name);
  const layerIds = /* @__PURE__ */ new Map();
  const classIds = /* @__PURE__ */ new Map();
  const attrIds = /* @__PURE__ */ new Map();
  let nextLayer = 1;
  let nextClass = 1;
  let nextAttr = 1;
  let featureId = 1;
  for (const f of features) {
    if (doc.features.length >= maxFeatures) {
      throw new ScrError(`feature count exceeds maxFeatures (${maxFeatures})`);
    }
    if (!f.geometry) continue;
    const layerName = resolveLayer(f, opts.layerKey);
    const className = resolveClass(f, layerName);
    const layerId = layerIds.get(layerName) ?? nextLayer;
    if (!layerIds.has(layerName)) {
      layerIds.set(layerName, layerId);
      doc.layers.set(layerId, { id: layerId, name: layerName });
      nextLayer++;
    }
    const classId = classIds.get(className) ?? nextClass;
    if (!classIds.has(className)) {
      classIds.set(className, classId);
      doc.classes.set(classId, { id: classId, layerId, name: className });
      nextClass++;
    }
    const geometry = quantize(f.geometry, envelope, extent, opts.projection ?? DEFAULT_PROJECTION);
    if (geometry === void 0) continue;
    const attrSet = buildAttrSet(f.properties ?? {}, alloc, attrIds, doc.attrSets, () => {
      return nextAttr++;
    });
    const sourceId = f.id !== void 0 ? Number(f.id) : Number.NaN;
    const feature = {
      id: Number.isFinite(sourceId) ? sourceId : featureId,
      layerId,
      classId,
      kind: geometry.kind,
      attrSet: attrSet ?? 0,
      geometry
    };
    doc.features.push(feature);
    featureId++;
  }
  for (const [id, s] of alloc.strings) doc.strings.set(id, s);
  for (const [i, h] of (collectionHeat ?? []).entries()) {
    const valid = typeof h?.name === "string" && Number.isFinite(h?.resolution) && h.resolution > 0 && Number.isFinite(h?.min) && Number.isFinite(h?.max) && Array.isArray(h?.cells) && h.cells.every(
      (c) => c && Number.isFinite(c.x) && Number.isFinite(c.y) && Number.isFinite(c.value)
    );
    if (!valid) {
      throw new Error(`invalid heat layer at index ${i}: expected {name, resolution, min, max, cells[]}`);
    }
    doc.heat.push({
      id: i + 1,
      name: h.name,
      resolution: h.resolution,
      minValue: h.min,
      maxValue: h.max,
      encoding: "sparse",
      cells: h.cells.map((c) => ({ x: c.x, y: c.y, value: c.value }))
    });
  }
  return doc;
}
__name(fromGeoJson, "fromGeoJson");
function emptyDocument(opts, extent, buffer) {
  return {
    version: 1,
    envelope: opts.envelope ?? { type: "tile", z: 0, x: 0, y: 0 },
    projection: opts.projection ?? DEFAULT_PROJECTION,
    extent,
    buffer,
    meta: { source: opts.source ?? "geojson" },
    layers: /* @__PURE__ */ new Map(),
    classes: /* @__PURE__ */ new Map(),
    strings: /* @__PURE__ */ new Map(),
    attrSets: /* @__PURE__ */ new Map(),
    features: [],
    heat: [],
    omissions: [],
    refs: [],
    routes: []
  };
}
__name(emptyDocument, "emptyDocument");
function coordsOf(geom) {
  if (!geom) return [];
  const out = [];
  walkCoords(geom.coordinates, out);
  return out;
}
__name(coordsOf, "coordsOf");
function walkCoords(node, out) {
  if (!Array.isArray(node)) return;
  if (node.length >= 2 && typeof node[0] === "number" && typeof node[1] === "number") {
    out.push([node[0], node[1]]);
    return;
  }
  for (const child of node) walkCoords(child, out);
}
__name(walkCoords, "walkCoords");
function quantize(geom, env, extent, projection) {
  const to = /* @__PURE__ */ __name((c) => {
    const p = c;
    return lonLatToGrid({ lon: p[0], lat: p[1] }, env, extent, projection);
  }, "to");
  switch (geom.type) {
    case "Point": {
      const p = to(geom.coordinates);
      const z = geom.coordinates[2];
      return { kind: "point", point: z === void 0 ? p : { ...p, z } };
    }
    case "MultiPoint": {
      const pts = geom.coordinates.map(to);
      if (pts.length === 0) return void 0;
      return { kind: "point", point: pts[0] };
    }
    case "LineString": {
      const line = geom.coordinates.map(to);
      if (line.length < 2) return void 0;
      return { kind: "line", lines: [line] };
    }
    case "MultiLineString": {
      const lines = geom.coordinates.map((l) => l.map(to)).filter((l) => l.length >= 2);
      if (lines.length === 0) return void 0;
      return { kind: "line", lines };
    }
    case "Polygon": {
      const poly = polygonOf(geom.coordinates, to);
      if (poly.length === 0) return void 0;
      return kindOfPolygon(geom, poly);
    }
    case "MultiPolygon": {
      const poly = geom.coordinates.flatMap((p) => polygonOf(p, to));
      if (poly.length === 0) return void 0;
      return kindOfPolygon(geom, poly);
    }
    default:
      throw new ScrError(`unsupported GeoJSON geometry type "${geom.type}"`);
  }
}
__name(quantize, "quantize");
function polygonOf(rings, to) {
  return rings.map((r) => r.map(to)).filter((r) => r.length >= 3).map((ringsOfPart) => ({ rings: [ringsOfPart] }));
}
__name(polygonOf, "polygonOf");
function kindOfPolygon(geom, poly) {
  void geom;
  return { kind: "polygon", polygon: poly };
}
__name(kindOfPolygon, "kindOfPolygon");
function resolveLayer(f, layerKey) {
  const props = f.properties ?? {};
  if (layerKey && typeof props[layerKey] === "string") return props[layerKey];
  const kind = keyOf(f);
  switch (kind) {
    case "line":
      return "road";
    case "point":
      return "poi";
    case "building":
      return "building";
    default:
      return "area";
  }
}
__name(resolveLayer, "resolveLayer");
function resolveClass(f, layerName) {
  const props = f.properties ?? {};
  for (const key of ["class", "supercarto_class"]) {
    if (typeof props[key] === "string") return props[key];
  }
  if (typeof props.type === "string" && props.type.includes(".")) {
    return props.type;
  }
  const highway = str(props.highway);
  if (highway) return `highway.${highway}`;
  const railway = str(props.railway);
  if (railway) return `railway.${railway}`;
  const amenity = str(props.amenity);
  if (amenity) return `amenity.${amenity}`;
  const shop = str(props.shop);
  if (shop) return `shop.${shop}`;
  const leisure = str(props.leisure);
  if (leisure) return `leisure.${leisure}`;
  const tourism = str(props.tourism);
  if (tourism) return `tourism.${tourism}`;
  if (layerName === "building" || props.building) return "building.commercial";
  const kind = keyOf(f);
  if (kind === "point") return "poi";
  if (kind === "line") return "highway.residential";
  return "area.generic";
}
__name(resolveClass, "resolveClass");
function keyOf(f) {
  const t = f.geometry?.type;
  const props = f.properties ?? {};
  if (t === "Point" || t === "MultiPoint") {
    return props.building || props["building:part"] ? "building" : "point";
  }
  if (t === "LineString" || t === "MultiLineString") return "line";
  return props.building ? "building" : "area";
}
__name(keyOf, "keyOf");
function str(v) {
  return typeof v === "string" && v !== "" ? v : void 0;
}
__name(str, "str");
function buildAttrSet(props, alloc, attrIds, out, nextId) {
  const list = [];
  for (const [key, keyId] of [...KEPT_KEYS.entries()].sort((a, b) => a[1] - b[1])) {
    const raw = props[key];
    if (raw === void 0 || raw === null || raw === "") continue;
    const value = toAttrValue(raw, alloc);
    if (value !== void 0) list.push({ key: keyId, value });
  }
  if (list.length === 0) return void 0;
  const signature = list.map((p) => `${p.key}=${renderValue(p.value)}`).join(";");
  const existing = attrIds.get(signature);
  if (existing !== void 0) return existing;
  const id = nextId();
  attrIds.set(signature, id);
  out.set(id, { id, props: list });
  return id;
}
__name(buildAttrSet, "buildAttrSet");
function toAttrValue(raw, alloc) {
  if (typeof raw === "number") return { t: "num", num: raw };
  if (typeof raw === "boolean") return { t: "bool", bool: raw };
  if (typeof raw === "string") {
    const asNumber = Number(raw);
    if (raw.trim() !== "" && Number.isFinite(asNumber)) {
      return { t: "num", num: asNumber };
    }
    if (BLOCKING_TOKENS.has(raw) || PATH_TOKENS.has(raw)) {
      return { t: "token", token: raw };
    }
    return { t: "ref", ref: intern(alloc, raw) };
  }
  return void 0;
}
__name(toAttrValue, "toAttrValue");
var BLOCKING_TOKENS = /* @__PURE__ */ new Set([
  "construction",
  "closed",
  "no",
  "barrier",
  "locked",
  "yes",
  "private"
]);
var PATH_TOKENS = /* @__PURE__ */ new Set([
  "footway",
  "pedestrian",
  "path",
  "steps",
  "cycleway",
  "corridor",
  "service",
  "track",
  "motorway",
  "trunk",
  "crossing",
  "crosswalk",
  "sidewalk"
]);
function renderValue(v) {
  switch (v.t) {
    case "ref":
      return `s${v.ref}`;
    case "num":
      return String(v.num);
    case "bool":
      return v.bool ? "true" : "false";
    case "token":
      return v.token;
  }
}
__name(renderValue, "renderValue");

// ../../src/geo/geometry.ts
function dedupeLine(line, closed = false) {
  const out = [];
  for (const p of line) {
    const last = out[out.length - 1];
    if (last && last.x === p.x && last.y === p.y) continue;
    out.push(p);
  }
  if (closed && out.length > 1) {
    const a = out[0];
    const b = out[out.length - 1];
    if (a.x === b.x && a.y === b.y) out.pop();
  }
  return out;
}
__name(dedupeLine, "dedupeLine");
function weldKey(p, quantum) {
  return `${Math.round(p.x / quantum)},${Math.round(p.y / quantum)}`;
}
__name(weldKey, "weldKey");
function bearing(a, b) {
  const dx = b.x - a.x;
  const dy = -(b.y - a.y);
  const deg = Math.atan2(dx, dy) * 180 / Math.PI;
  return (deg + 360) % 360;
}
__name(bearing, "bearing");
var COMPASS = [
  "north",
  "northeast",
  "east",
  "southeast",
  "south",
  "southwest",
  "west",
  "northwest"
];
function compassOf(a, b) {
  const deg = bearing(a, b);
  const idx = Math.round(deg / 45) % 8;
  return COMPASS[idx];
}
__name(compassOf, "compassOf");
function oppositeCompass(c) {
  const map = {
    north: "south",
    northeast: "southwest",
    east: "west",
    southeast: "northwest",
    south: "north",
    southwest: "northeast",
    west: "east",
    northwest: "southeast"
  };
  return map[c];
}
__name(oppositeCompass, "oppositeCompass");

// ../../src/compile/indoor.ts
var NO_INDOOR = {
  multiStorey: false,
  levels: [],
  vertical: [],
  missingLevels: [],
  omitted: []
};
function emptyIndoor() {
  return { ...NO_INDOOR, levels: [], vertical: [], omitted: [] };
}
__name(emptyIndoor, "emptyIndoor");
function buildIndoorGraph(features, opts) {
  if (features.length === 0) return emptyIndoor();
  const levels = features.filter((f) => f.level !== void 0);
  if (levels.length === 0) return emptyIndoor();
  const present = [...new Set(levels.map((f) => f.level))].sort((a, b) => a - b);
  const multiStorey = present.length > 1;
  const maxLevels = opts.maxLevels ?? 8;
  const maxNodes = opts.maxNodesPerLevel ?? 60;
  const mpu = opts.metresPerUnit;
  const shaftFeatures = levels.filter(isShaft);
  const vertical = buildVerticalLinks(shaftFeatures, mpu);
  const usableVertical = vertical.filter((v) => v.levels.length > 1);
  const taken = new Set(
    usableVertical.flatMap(
      (v) => shaftFeatures.filter((s) => isShaft(s) && shaftKey(s) === v.key).map((s) => s.id)
    )
  );
  const out = [];
  const omitted = [];
  for (const level of present) {
    if (out.length >= maxLevels) {
      omitted.push({ level, reason: `storey budget of ${maxLevels} reached` });
      continue;
    }
    const onLevel = levels.filter((f) => f.level === level && !taken.has(f.id));
    if (onLevel.length === 0) {
      if (usableVertical.some((v) => v.levels.includes(level))) continue;
      omitted.push({ level, reason: "no walkable features tagged on this storey" });
      continue;
    }
    const graph = buildLevelGraph(level, onLevel, mpu, maxNodes);
    if (graph === void 0) {
      omitted.push({ level, reason: "no corridor to connect rooms to" });
      continue;
    }
    out.push(graph);
  }
  const missingLevels = [];
  for (let i = 1; i < present.length; i++) {
    const lo = present[i - 1];
    const hi = present[i];
    if (hi - lo > 1) for (let s = lo + 1; s < hi; s++) missingLevels.push(s);
  }
  return {
    multiStorey,
    levels: out,
    vertical: usableVertical,
    missingLevels,
    omitted
  };
}
__name(buildIndoorGraph, "buildIndoorGraph");
function buildLevelGraph(level, features, mpu, maxNodes) {
  const corridors = features.filter(isCorridor);
  if (corridors.length === 0) return void 0;
  const nodes = [];
  const edges = [];
  const byId = /* @__PURE__ */ new Map();
  const add = /* @__PURE__ */ __name((f, kind) => {
    if (nodes.length >= maxNodes) return void 0;
    const id = `L${level}n${nodes.length + 1}`;
    const node = {
      id,
      level,
      kind,
      ...f.name ? { name: f.name } : {},
      ...f.indoor ? { indoor: f.indoor } : {},
      ...f.wheelchair !== void 0 ? { wheelchair: f.wheelchair } : {}
    };
    nodes.push(node);
    byId.set(f.id, node);
    return node;
  }, "add");
  const corridorNodes = corridors.slice(0, Math.max(1, Math.floor(maxNodes / 3))).map((f) => add(f, "corridor")).filter((n) => n !== void 0);
  if (corridorNodes.length === 0) return void 0;
  for (let i = 0; i < corridorNodes.length; i++) {
    for (let j = i + 1; j < corridorNodes.length; j++) {
      const a = corridorNodes[i];
      const b = corridorNodes[j];
      const d = metresBetween(a, b, features, byId, mpu);
      if (d !== void 0 && d <= 60) {
        edges.push({ from: a.id, to: b.id, distM: Math.round(d), level });
      }
    }
  }
  const attachable = features.filter((f) => !isCorridor(f) && !isShaft(f));
  for (const f of attachable) {
    const kind = kindOf(f);
    const node = add(f, kind);
    if (!node) break;
    let best;
    for (const c of corridorNodes) {
      const d = metresBetween(node, c, features, byId, mpu);
      if (d === void 0) continue;
      if (!best || d < best.d) best = { c, d };
    }
    if (!best) continue;
    if (best.d > 40) continue;
    edges.push({
      from: best.c.id,
      to: node.id,
      distM: Math.round(best.d),
      level,
      ...f.blocked ? { blocked: true } : {},
      ...f.door ? { door: f.door } : {}
    });
  }
  return { level, label: levelLabel(level), nodes, edges };
}
__name(buildLevelGraph, "buildLevelGraph");
function buildVerticalLinks(shafts, mpu) {
  const groups = /* @__PURE__ */ new Map();
  for (const s of shafts) {
    const key = shaftKey(s);
    const list = groups.get(key);
    if (list) list.push(s);
    else groups.set(key, [s]);
  }
  const out = [];
  let n = 1;
  for (const [key, group] of groups) {
    const levels = [...new Set(group.map((f) => f.level))].sort((a, b) => a - b);
    if (levels.length < 2 && group.length > 1) {
      const spread = spreadOf(group, mpu);
      if (spread > 25) continue;
    }
    const kind = kindOf(group[0]);
    const wheelchair = group.some((f) => f.wheelchair === true);
    out.push({
      id: `v${n++}`,
      kind: kind === "stairs" ? "stairs" : kind === "lift" ? "lift" : kind,
      levels,
      ...wheelchair ? { wheelchair } : {},
      ...group[0].name ? { name: group[0].name } : {},
      key
    });
  }
  return out;
}
__name(buildVerticalLinks, "buildVerticalLinks");
function isCorridor(f) {
  if (f.indoor === "corridor") return true;
  return f.indoor !== void 0 && !f.room && !isShaft(f);
}
__name(isCorridor, "isCorridor");
function isShaft(f) {
  return f.indoor === "lift" || f.indoor === "elevator" || f.indoor === "stairs" || f.indoor === "escalator";
}
__name(isShaft, "isShaft");
function kindOf(f) {
  if (f.indoor === "lift" || f.indoor === "elevator") return "lift";
  if (f.indoor === "stairs") return "stairs";
  if (f.indoor === "corridor") return "corridor";
  if (f.indoor === "room" || f.room) return f.name ? "shop" : "room";
  if (f.indoor === "door") return "door";
  return "unknown";
}
__name(kindOf, "kindOf");
function shaftKey(f) {
  return `${Math.round(f.x / 32)}:${Math.round(f.y / 32)}`;
}
__name(shaftKey, "shaftKey");
function spreadOf(group, mpu) {
  if (group.length < 2) return 0;
  const xs = group.map((f) => f.x);
  const ys = group.map((f) => f.y);
  const dx = (Math.max(...xs) - Math.min(...xs)) * mpu;
  const dy = (Math.max(...ys) - Math.min(...ys)) * mpu;
  return Math.hypot(dx, dy);
}
__name(spreadOf, "spreadOf");
function metresBetween(a, b, features, byId, mpu) {
  const fa = features.find((f) => byId.get(f.id) === a);
  const fb = features.find((f) => byId.get(f.id) === b);
  if (!fa || !fb) return void 0;
  return Math.hypot(fa.x - fb.x, fa.y - fb.y) * mpu;
}
__name(metresBetween, "metresBetween");
function levelLabel(level) {
  if (level === 0) return "ground";
  if (level === 1) return "1";
  if (level === -1) return "basement";
  if (level < 0) return `basement ${Math.abs(level)}`;
  return String(level);
}
__name(levelLabel, "levelLabel");
function isMeaningfulIndoor(graph) {
  if (graph.levels.length === 0) return false;
  const nodes = graph.levels.reduce((a, l) => a + l.nodes.length, 0);
  return nodes >= 3 || graph.vertical.length > 0;
}
__name(isMeaningfulIndoor, "isMeaningfulIndoor");

// ../../src/source/sun.ts
var RAD = Math.PI / 180;
var DEG2 = 180 / Math.PI;
function sunPosition(lat, lon, at = /* @__PURE__ */ new Date()) {
  const jd = toJulianDay(at);
  const d = jd - 2451545;
  const meanAnomaly = (357.5291 + 0.98560028 * d) * RAD;
  const obliquity = 23.439 - 4e-7 * d;
  const eclipticLongitude = (280.459 + 0.98564736 * d) * RAD;
  const declination = Math.asin(Math.sin(obliquity * RAD) * Math.sin(eclipticLongitude)) * DEG2;
  const y = Math.tan(obliquity / 2 * RAD) ** 2;
  const eqOfTime = 4 * DEG2 * (y * Math.sin(2 * meanAnomaly) - 2 * 0.016708634 * Math.sin(meanAnomaly) + 4 * 0.016708634 * y * Math.sin(meanAnomaly) * Math.cos(2 * meanAnomaly) - 0.5 * y * y * Math.sin(4 * meanAnomaly) - 1.25 * 0.016708634 ** 2 * Math.sin(2 * meanAnomaly));
  const dayFraction = ((jd + 0.5) % 1 + 1) % 1;
  const trueSolarTime = (dayFraction * 1440 + eqOfTime + 4 * lon + 2880) % 1440;
  const hourAngle = trueSolarTime / 4 - 180;
  const latR = lat * RAD;
  const decR = declination * RAD;
  const haR = hourAngle * RAD;
  const cosZenith = Math.sin(latR) * Math.sin(decR) + Math.cos(latR) * Math.cos(decR) * Math.cos(haR);
  const zenith = Math.acos(Math.max(-1, Math.min(1, cosZenith))) * DEG2;
  const elevation = 90 - zenith;
  let azimuth;
  const denom = Math.cos(latR) * Math.sin(zenith * RAD);
  if (Math.abs(denom) > 1e-9) {
    let cosAz = (Math.sin(latR) * Math.cos(zenith * RAD) - Math.sin(decR)) / denom;
    cosAz = Math.max(-1, Math.min(1, cosAz));
    azimuth = Math.acos(cosAz) * DEG2;
    if (hourAngle > 0) azimuth = 360 - azimuth;
  } else {
    azimuth = lat >= 0 ? 180 : 0;
  }
  const daylight = elevation > 0;
  const twilight = elevation > 6 ? "day" : elevation > -0.833 ? "civil" : elevation > -12 ? "nautical" : "night";
  const cosHA = (Math.sin(-0.833 * RAD) - Math.sin(latR) * Math.sin(decR)) / (Math.cos(latR) * Math.cos(decR));
  let polar = false;
  let sunrise;
  let sunset;
  if (cosHA > 1) {
    polar = "night";
  } else if (cosHA < -1) {
    polar = "day";
  } else {
    const ha = Math.acos(cosHA) * DEG2;
    const haMinutes = 4 * ha;
    const noonMinutes = 720 - 4 * lon - eqOfTime;
    sunrise = isoFromMinutes(noonMinutes - haMinutes, at);
    sunset = isoFromMinutes(noonMinutes + haMinutes, at);
  }
  return {
    elevationDeg: round(elevation, 1),
    azimuthDeg: round(azimuth, 0),
    daylight,
    twilight,
    ...sunrise ? { sunrise } : {},
    ...sunset ? { sunset } : {},
    polar
  };
}
__name(sunPosition, "sunPosition");
function toJulianDay(at) {
  return at.getTime() / 864e5 + 24405875e-1;
}
__name(toJulianDay, "toJulianDay");
function isoFromMinutes(minutes, reference) {
  const base = Date.UTC(
    reference.getUTCFullYear(),
    reference.getUTCMonth(),
    reference.getUTCDate()
  );
  const shifted = new Date(base + Math.round(minutes) * 6e4);
  return shifted.toISOString().replace(/\.\d+Z$/, "Z");
}
__name(isoFromMinutes, "isoFromMinutes");
function round(n, places) {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}
__name(round, "round");
function needsLight(sun) {
  return sun.elevationDeg < 6;
}
__name(needsLight, "needsLight");

// ../../src/source/hours.ts
var DAY_TOKENS = {
  su: 0,
  sun: 0,
  sunday: 0,
  mo: 1,
  mon: 1,
  monday: 1,
  tu: 2,
  tue: 2,
  tues: 2,
  tuesday: 2,
  we: 3,
  wed: 3,
  weds: 3,
  wednesday: 3,
  th: 4,
  thu: 4,
  thur: 4,
  thurs: 4,
  thursday: 4,
  fr: 5,
  fri: 5,
  friday: 5,
  sa: 6,
  sat: 6,
  saturday: 6
};
function evaluateOpeningHours(spec, at, utcOffsetMinutes) {
  if (!spec || spec.trim() === "") return unknownState();
  const raw = spec.trim();
  const lower = raw.toLowerCase();
  if (lower === "24/7") {
    return { open: true, opensAt: "00:00", closesAt: "24:00", unknown: false };
  }
  if (lower === "off" || lower === "closed") {
    return { open: false, rule: "always closed", unknown: false };
  }
  const offset = utcOffsetMinutes ?? -at.getTimezoneOffset();
  const localMs = at.getTime() + offset * 6e4;
  const weekday = new Date(localMs).getUTCDay();
  const minutes = new Date(localMs).getUTCHours() * 60 + new Date(localMs).getUTCMinutes();
  const applicable = ruleFor(lower, weekday);
  if (applicable === null) {
    return { open: true, rule: "no hours listed for this day", unknown: true };
  }
  if (applicable === "off" || applicable === "closed") {
    return { open: false, rule: "closed on this day", unknown: false };
  }
  const windows = parseWindows(applicable);
  if (windows.length === 0) {
    return { open: true, rule: applicable, unknown: true };
  }
  const yesterday = ruleFor(lower, (weekday + 6) % 7);
  const spillover = yesterday === null ? [] : parseWindows(yesterday).filter((w) => w.crossesMidnight);
  const openNow = /* @__PURE__ */ __name((w) => w.crossesMidnight ? minutes >= w.from : minutes >= w.from && minutes < w.to, "openNow");
  const openFromSpill = /* @__PURE__ */ __name((w) => minutes < w.to - 1440, "openFromSpill");
  if (windows.length === 1 && spillover.length === 0 && !windows[0].crossesMidnight) {
    const w = windows[0];
    return {
      open: openNow(w),
      opensAt: formatMinutes(w.from),
      closesAt: formatMinutes(w.to),
      unknown: false
    };
  }
  const open = windows.some(openNow) || spillover.some(openFromSpill);
  return { open, rule: applicable, unknown: false };
}
__name(evaluateOpeningHours, "evaluateOpeningHours");
function ruleFor(spec, weekday) {
  let found = null;
  for (const part of splitRules(spec)) {
    if (part.selector === null) continue;
    if (!selectorMatches(part.selector, weekday)) continue;
    found = part.rule;
  }
  return found;
}
__name(ruleFor, "ruleFor");
function unknownState() {
  return { open: true, unknown: true, rule: "no opening hours recorded" };
}
__name(unknownState, "unknownState");
function splitRules(text) {
  const out = [];
  let depth = 0;
  let current = "";
  for (const ch of text) {
    if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    if (ch === ";" && depth === 0) {
      pushRule(out, current);
      current = "";
    } else {
      current += ch;
    }
  }
  pushRule(out, current);
  return out;
}
__name(splitRules, "splitRules");
function pushRule(out, text) {
  const trimmed = text.trim();
  if (trimmed === "") return;
  const withoutException = trimmed.replace(/\([^)]*\)/g, " ").trim();
  const spaceAt = withoutException.indexOf(" ");
  if (spaceAt <= 0) {
    out.push({ selector: null, rule: withoutException });
    return;
  }
  out.push({
    selector: withoutException.slice(0, spaceAt),
    rule: withoutException.slice(spaceAt + 1).trim()
  });
}
__name(pushRule, "pushRule");
function selectorMatches(selector, weekday) {
  for (const token of selector.split(",")) {
    const t = token.trim();
    if (t === "") continue;
    if (t === "PH" || t === "SH") continue;
    const dash = t.indexOf("-");
    if (dash > 0) {
      const from = DAY_TOKENS[t.slice(0, dash).trim()];
      const to = DAY_TOKENS[t.slice(dash + 1).trim()];
      if (from === void 0 || to === void 0) continue;
      if (from <= to) {
        if (weekday >= from && weekday <= to) return true;
      } else if (weekday >= from || weekday <= to) return true;
      continue;
    }
    const d = DAY_TOKENS[t];
    if (d !== void 0 && d === weekday) return true;
  }
  return false;
}
__name(selectorMatches, "selectorMatches");
function parseWindows(rule) {
  const out = [];
  const re = /(\d{1,2}):?(\d{2})\s*-\s*(\d{1,2}):?(\d{2})/g;
  let m;
  while ((m = re.exec(rule)) !== null) {
    const from = Number(m[1]) * 60 + Number(m[2]);
    const rawTo = Number(m[3]) * 60 + Number(m[4]);
    const crossesMidnight = rawTo <= from;
    const to = crossesMidnight ? rawTo + 1440 : rawTo;
    out.push({ from, to, crossesMidnight });
  }
  return out;
}
__name(parseWindows, "parseWindows");
function formatMinutes(m) {
  const wrapped = (m % 1440 + 1440) % 1440;
  const h = Math.floor(wrapped / 60);
  const min = wrapped % 60;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}
__name(formatMinutes, "formatMinutes");
function openingPhrase(spec, at, utcOffsetMinutes) {
  const s = evaluateOpeningHours(spec, at, utcOffsetMinutes);
  if (s.unknown) return s.rule ?? "hours unknown";
  if (!s.open) return s.rule ?? "closed";
  if (s.opensAt && s.closesAt) return `${s.opensAt}-${s.closesAt}`;
  return "open";
}
__name(openingPhrase, "openingPhrase");

// ../../src/toolcatalog.ts
var TOOL_CATALOG = [
  {
    name: "get_maplet",
    signature: "get_maplet(lat,lon,radius,layers,budget)",
    use: "what is near this coordinate",
    requiresElevation: false,
    requiresWeather: false,
    requiresTraffic: false,
    requiresTransit: false
  },
  {
    name: "localize",
    signature: "localize(scr,lat,lon,radius,layers,budget)",
    use: "move within an open map session; returns only what changed",
    requiresElevation: false,
    requiresWeather: false,
    requiresTraffic: false,
    requiresTransit: false
  },
  {
    name: "route",
    signature: "route(from,to,mode)",
    use: "straight-line distance, direction, and walking feasibility between two points; verify the approach on arrival",
    requiresElevation: false,
    requiresWeather: false,
    requiresTraffic: false,
    requiresTransit: false
  },
  {
    name: "search_places",
    signature: "search_places(lat,lon,radius,query,limit)",
    use: "find places by name or type",
    requiresElevation: false,
    requiresWeather: false,
    requiresTraffic: false,
    requiresTransit: false
  },
  {
    name: "expand_feature",
    signature: "expand_feature(id)",
    use: "exact geometry for a feature in this maplet",
    requiresElevation: false,
    requiresWeather: false,
    requiresTraffic: false,
    requiresTransit: false
  },
  {
    name: "get_terrain",
    signature: "get_terrain(lat,lon,radiusM,samples)",
    use: "ground elevation and slope around a coordinate",
    requiresElevation: true,
    requiresWeather: false,
    requiresTraffic: false,
    requiresTransit: false
  },
  {
    name: "get_weather",
    signature: "get_weather(lat,lon,hours)",
    use: "current conditions and forecast, for deciding whether to go out",
    requiresElevation: false,
    requiresWeather: true,
    requiresTraffic: false,
    requiresTransit: false
  },
  {
    name: "get_traffic",
    signature: "get_traffic(from,to,mode)",
    use: "congestion and realistic arrival time for a drive",
    requiresElevation: false,
    requiresWeather: false,
    requiresTraffic: true,
    requiresTransit: false
  },
  {
    name: "get_transit",
    signature: "get_transit(lat,lon,radiusM,budget)",
    use: "transit stops, lines, and service times around a coordinate, from a configured GTFS feed",
    requiresElevation: false,
    requiresWeather: false,
    requiresTraffic: false,
    requiresTransit: true
  },
  {
    name: "get_daylight",
    signature: "get_daylight(lat,lon,at)",
    use: "sun position, sunrise, sunset, and whether a light is needed",
    requiresElevation: false,
    requiresWeather: false,
    requiresTraffic: false,
    requiresTransit: false
  }
];
function advertisedTools(caps = {}) {
  const c = typeof caps === "boolean" ? { elevation: caps } : caps;
  return TOOL_CATALOG.filter((t) => available(t, c)).map((t) => t.signature);
}
__name(advertisedTools, "advertisedTools");
function available(t, c) {
  if (t.requiresElevation && !c.elevation) return false;
  if (t.requiresWeather && !c.weather) return false;
  if (t.requiresTraffic && !c.traffic) return false;
  if (t.requiresTransit && !c.transit) return false;
  return true;
}
__name(available, "available");

// ../../src/compile/compiler.ts
var DEFAULT_WELD = 2;
var DEFAULT_MAX_NODES = 4e3;
var DEFAULT_MAX_NAMED_NODES = 512;
var POI_CLASSES = /* @__PURE__ */ new Set([
  "amenity.cafe",
  "amenity.restaurant",
  "amenity.bar",
  "amenity.pharmacy",
  "amenity.hospital",
  "amenity.school",
  "amenity.bank",
  "amenity.fuel",
  "amenity.parking",
  "amenity.bus_station",
  "amenity.marketplace",
  "shop",
  "leisure.park",
  "leisure.playground",
  "tourism.attraction",
  "tourism.hotel",
  "office"
]);
var TRANSIT_CLASSES = /* @__PURE__ */ new Set([
  "railway.station",
  "railway.subway_entrance",
  "public_transport.stop_position",
  "public_transport.station",
  "highway.bus_stop",
  "railway.tram_stop",
  "railway.light_rail"
]);
var BLOCKING_TAGS = /* @__PURE__ */ new Set(["construction", "closed", "no", "barrier", "locked"]);
var PATH_HINTS = [
  { match: "footway", path: "sidewalk" },
  { match: "pedestrian", path: "sidewalk" },
  { match: "path", path: "path" },
  { match: "steps", path: "stairs" },
  { match: "cycleway", path: "bikeway" },
  { match: "corridor", path: "indoor" },
  { match: "service", path: "service" },
  { match: "track", path: "track" },
  { match: "motorway", path: "highway" },
  { match: "trunk", path: "highway" }
];
function compile(doc, opts = {}) {
  const weld = opts.weld ?? DEFAULT_WELD;
  const maxNodes = opts.maxNodes ?? DEFAULT_MAX_NODES;
  const excluded = new Set(opts.exclude ?? []);
  const b = {
    doc,
    env: doc.envelope,
    extent: doc.extent,
    weld,
    nodes: [],
    edges: [],
    obstacles: [],
    junctionIndex: /* @__PURE__ */ new Map(),
    featureIndex: /* @__PURE__ */ new Map(),
    anchors: /* @__PURE__ */ new Map(),
    pinned: /* @__PURE__ */ new Set(),
    nextId: 1,
    used: /* @__PURE__ */ new Set(),
    now: opts.now ?? /* @__PURE__ */ new Date(),
    utcOffsetMinutes: opts.utcOffsetMinutes
  };
  const className = /* @__PURE__ */ __name((id) => doc.classes.get(id)?.name ?? "", "className");
  const layerName = /* @__PURE__ */ __name((id) => doc.layers.get(id)?.name ?? "", "layerName");
  const namedReserve = Math.min(
    opts.maxNamedNodes ?? DEFAULT_MAX_NAMED_NODES,
    Math.floor(maxNodes / 2)
  );
  const lineNodeCeiling = Math.max(0, maxNodes - namedReserve);
  const lineFeatures = doc.features.filter((f) => f.kind === "line");
  const areaFeatures = doc.features.filter(
    (f) => f.kind === "polygon" || f.kind === "building"
  );
  const pointFeatures = doc.features.filter((f) => f.kind === "point");
  for (const f of lineFeatures) {
    if (excluded.has(className(f.classId))) continue;
    if (b.nodes.length >= lineNodeCeiling) break;
    compileLinear(b, f, className(f.classId), layerName(f.layerId));
  }
  for (const f of pointFeatures) {
    if (excluded.has(className(f.classId))) continue;
    if (isFurniture(className(f.classId))) continue;
    if (WEAK_POI_CLASSES.has(className(f.classId)) && !isNamed(doc, f)) continue;
    if (b.nodes.length >= maxNodes) break;
    compilePoint(b, f, className(f.classId), layerName(f.layerId));
  }
  for (const f of areaFeatures) {
    if (excluded.has(className(f.classId))) continue;
    if (b.nodes.length >= maxNodes) break;
    compileArea(b, f, className(f.classId), layerName(f.layerId));
  }
  pruneIsolated(b);
  attachStrandedLandmarks(b);
  const heat = compileHeat(doc, doc.envelope, opts.maxHotspots ?? 5);
  const indoor = opts.indoor === false ? emptyIndoor() : compileIndoor(doc, opts);
  return {
    meta: buildMeta(doc, opts),
    nodes: b.nodes,
    edges: b.edges,
    obstacles: b.obstacles,
    heat,
    indoor,
    omitted: compileOmissions(doc),
    tools: advertisedTools(
      opts.capabilities ?? { elevation: opts.hasElevation ?? false, weather: false, traffic: false }
    ),
    pinned: [...b.pinned],
    partial: doc.omissions.length > 0
  };
}
__name(compile, "compile");
function compileIndoor(doc, opts) {
  const features = [];
  for (const f of doc.features) {
    const props = propsOf(doc, f.attrSet);
    const levelRaw = propString(doc, props, "layer") ?? propString(doc, props, "level");
    const indoor = propString(doc, props, "indoor");
    if (levelRaw === void 0 && indoor === void 0) continue;
    const level = parseLevel(levelRaw);
    const name = propString(doc, props, "name");
    const kindHint = indoor ?? classNameOf(doc, f.classId);
    if (indoor === "no") continue;
    const centre = centroidOf(f);
    if (!centre) continue;
    const wheelchair = wheelchairOf(doc, props);
    const extent = extentOf(f);
    features.push({
      id: f.id,
      ...level !== void 0 ? { level } : {},
      ...name ? { name } : {},
      ...indoor ? { indoor } : {},
      room: kindHint === "room" || indoor === void 0 && level !== void 0 && f.kind === "polygon",
      x: centre.x,
      y: centre.y,
      ...extent !== void 0 ? { extent } : {},
      ...indoor === "door" || indoor === "wall" ? { blocked: false } : {},
      ...wheelchair !== void 0 ? { wheelchair } : {},
      ...propString(doc, props, "door") ? { door: propString(doc, props, "door") } : {}
    });
  }
  if (features.length === 0) return emptyIndoor();
  const mpu = indoorMetresPerUnit(features, doc);
  const graph = buildIndoorGraph(features, {
    metresPerUnit: mpu,
    maxNodesPerLevel: opts.maxIndoorNodesPerLevel ?? 60,
    maxLevels: opts.maxIndoorLevels ?? 8
  });
  return isMeaningfulIndoor(graph) ? graph : emptyIndoor();
}
__name(compileIndoor, "compileIndoor");
function indoorMetresPerUnit(features, doc) {
  const xs = features.map((f) => f.x);
  const ys = features.map((f) => f.y);
  const spanGrid = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  if (spanGrid <= 0) return 1;
  const env = doc.envelope;
  let envelopeMetres;
  if (env.type === "bbox") {
    const midLat = (env.north + env.south) / 2;
    envelopeMetres = Math.max(
      Math.abs(env.east - env.west) * 111320 * Math.cos(midLat * Math.PI / 180),
      Math.abs(env.north - env.south) * 110574
    ) || void 0;
  } else {
    const b = tileBounds(env.z, env.x, env.y);
    const midLat = (b.north + b.south) / 2;
    envelopeMetres = Math.max(
      Math.abs(b.east - b.west) * 111320 * Math.cos(midLat * Math.PI / 180),
      Math.abs(b.north - b.south) * 110574
    ) || void 0;
  }
  if (envelopeMetres === void 0) return 1;
  const perUnit = envelopeMetres / Math.max(1, doc.extent);
  return perUnit;
}
__name(indoorMetresPerUnit, "indoorMetresPerUnit");
function parseLevel(raw) {
  if (raw === void 0) return void 0;
  const trimmed = raw.trim();
  if (trimmed === "") return void 0;
  const n = Number(trimmed);
  if (Number.isFinite(n)) return n;
  const named = {
    ground: 0,
    groundfloor: 0,
    ground_floor: 0,
    "ground-floor": 0,
    main: 0,
    lobby: 0,
    reception: 0,
    basement: -1,
    underground: -1,
    lowerground: -1
  };
  return named[trimmed.toLowerCase().replace(/\s+/g, "")];
}
__name(parseLevel, "parseLevel");
function centroidOf(f) {
  const g = f.geometry;
  if (g.kind === "point") return { x: g.point.x, y: g.point.y };
  const ring = g.kind === "line" ? g.lines[0] : g.polygon[0]?.rings[0];
  if (!ring || ring.length === 0) return void 0;
  return ringCentroid(ring);
}
__name(centroidOf, "centroidOf");
function extentOf(f) {
  const g = f.geometry;
  if (g.kind === "line") return polylineLength(g.lines);
  if (g.kind === "polygon") {
    const ring = g.polygon[0]?.rings[0];
    return ring ? polylineLength([ring]) : void 0;
  }
  return void 0;
}
__name(extentOf, "extentOf");
function polylineLength(lines) {
  let total = 0;
  for (const line of lines) {
    for (let i = 1; i < line.length; i++) {
      const a = line[i - 1];
      const b = line[i];
      total += Math.hypot(b.x - a.x, b.y - a.y);
    }
  }
  return total || void 0;
}
__name(polylineLength, "polylineLength");
function propString(doc, props, key) {
  for (const p of props) {
    if (doc.strings.get(p.key) !== key) continue;
    const v = resolveProp(doc, p);
    if (typeof v === "string" && v !== "") return v;
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
  }
  return void 0;
}
__name(propString, "propString");
function propToken(doc, props, key) {
  for (const p of props) {
    if (doc.strings.get(p.key) !== key) continue;
    const v = resolveProp(doc, p);
    if (typeof v === "string" && v !== "") return v;
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
  }
  return void 0;
}
__name(propToken, "propToken");
function hoursOf(doc, props, now, utcOffsetMinutes) {
  const raw = propString(doc, props, "opening_hours");
  if (raw === void 0) return void 0;
  const phrase = openingPhrase(raw, now, utcOffsetMinutes);
  return phrase === void 0 ? void 0 : phrase;
}
__name(hoursOf, "hoursOf");
function wheelchairOf(doc, props) {
  const v = propToken(doc, props, "wheelchair");
  if (v === "yes" || v === "true") return true;
  if (v === "no" || v === "false") return false;
  return void 0;
}
__name(wheelchairOf, "wheelchairOf");
function classNameOf(doc, classId) {
  return doc.classes.get(classId)?.name ?? "";
}
__name(classNameOf, "classNameOf");
function compileLinear(b, f, className, layerName) {
  const path = classPathHint(className, layerName);
  if (f.geometry.kind !== "line") return;
  const props = propsOf(b.doc, f.attrSet);
  const blocked = isBlocked(props);
  const crosswalk = hasToken(b.doc, props, "crossing") || hasToken(b.doc, props, "crosswalk");
  for (const coords of f.geometry.lines) {
    const line = dedupeLine(coords, false);
    if (line.length < 2) continue;
    let prevId;
    for (let i = 0; i < line.length; i++) {
      const pt = line[i];
      const key = weldKey(pt, b.weld);
      let nodeId = b.junctionIndex.get(key);
      if (nodeId === void 0) {
        nodeId = addNode(b, { kind: "intersection", features: [f.id], layer: layerName }, pt);
        b.junctionIndex.set(key, nodeId);
      } else {
        const existing = nodeById(b, nodeId);
        if (existing && !existing.features.includes(f.id)) existing.features.push(f.id);
      }
      if (prevId !== void 0 && prevId !== nodeId) {
        addEdge(b, prevId, nodeId, path, blocked, crosswalk, f.id);
      }
      prevId = nodeId;
    }
  }
}
__name(compileLinear, "compileLinear");
function compileArea(b, f, className, layer) {
  if (f.geometry.kind !== "polygon" && f.geometry.kind !== "building") return;
  const props = propsOf(b.doc, f.attrSet);
  const name = stringProp(b.doc, props, "name");
  const tags = collectTags(className, props);
  const kind = f.geometry.kind === "building" || className.startsWith("building") ? "building" : "area";
  let centroid;
  for (const part of f.geometry.polygon) {
    const ring = part.rings[0];
    if (ring && ring.length >= 3) {
      centroid = ringCentroid(ring);
      break;
    }
  }
  if (!centroid) return;
  const key = weldKey(centroid, b.weld);
  const existingId = b.junctionIndex.get(key);
  if (existingId !== void 0) {
    const n = nodeById(b, existingId);
    if (!n.features.includes(f.id)) n.features.push(f.id);
    if (name && !n.name) n.name = name;
    if (kind === "building" && n.kind === "intersection") n.kind = "building";
    if (tags.length > 0) n.tags = dedupe([...n.tags ?? [], ...tags]);
    const h2 = numProp(b.doc, props, "height_m", "height", "building:levels");
    if (h2 !== void 0) n.heightM = h2;
    return;
  }
  const partial = { kind, features: [f.id], layer };
  if (name) partial.name = name;
  if (tags.length > 0) partial.tags = tags;
  const h = numProp(b.doc, props, "height_m", "height", "building:levels");
  if (h !== void 0) partial.heightM = h;
  const id = addNode(b, partial, centroid);
  b.featureIndex.set(f.id, id);
  const near = nearestNode(b, centroid, allNodes(b), "");
  if (near !== void 0 && near !== id) {
    addEdge(b, near, id, "access", false, false, f.id);
  } else {
    b.used.add(id);
  }
}
__name(compileArea, "compileArea");
function ringCentroid(ring) {
  let x = 0;
  let y = 0;
  for (const p of ring) {
    x += p.x;
    y += p.y;
  }
  return { x: Math.round(x / ring.length), y: Math.round(y / ring.length) };
}
__name(ringCentroid, "ringCentroid");
function addEdge(b, fromId, toId, path, blocked, crosswalk, featureId) {
  const fromPt = b.anchors.get(fromId);
  const toPt = b.anchors.get(toId);
  if (!fromPt || !toPt) return;
  const dx = toPt.x - fromPt.x;
  const dy = toPt.y - fromPt.y;
  const dist = Math.hypot(dx, dy);
  const dir = compassOf(fromPt, toPt);
  const base = /* @__PURE__ */ __name((d) => {
    const edge = { from: fromId, to: toId, dist, dx, dy, dir: d, features: [featureId] };
    if (path) edge.path = path;
    if (crosswalk) edge.crosswalk = true;
    if (blocked) edge.blocked = true;
    return edge;
  }, "base");
  b.edges.push(base(dir), {
    ...base(oppositeCompass(dir)),
    from: toId,
    to: fromId,
    dx: -dx,
    dy: -dy
  });
  b.used.add(fromId);
  b.used.add(toId);
  if (blocked) {
    b.obstacles.push({ edge: `${fromId}->${toId}`, type: path ?? "obstruction", blocks: true });
  }
}
__name(addEdge, "addEdge");
function addNode(b, partial, at) {
  const id = `n${b.nextId++}`;
  const node = { id, ...partial };
  b.nodes.push(node);
  b.anchors.set(id, at);
  return id;
}
__name(addNode, "addNode");
function nodeById(b, id) {
  return b.nodes.find((n) => n.id === id);
}
__name(nodeById, "nodeById");
function compilePoint(b, f, className, layer) {
  if (f.geometry.kind !== "point") return;
  const p = f.geometry.point;
  const key = weldKey(p, b.weld);
  const props = propsOf(b.doc, f.attrSet);
  const name = stringProp(b.doc, props, "name");
  const tags = collectTags(className, props);
  const kind = nodeKindFor(className);
  const snapped = b.junctionIndex.get(key);
  const hours = hoursOf(b.doc, props, b.now, b.utcOffsetMinutes);
  const brand = stringProp(b.doc, props, "brand");
  if (snapped !== void 0) {
    const n = nodeById(b, snapped);
    if (!n.features.includes(f.id)) n.features.push(f.id);
    if (name && !n.name) {
      n.name = name;
      n.kind = kind === "intersection" ? n.kind : kind;
    }
    if (tags.length > 0) {
      n.tags = dedupe([...n.tags ?? [], ...tags]);
    }
    if (kind === "building") {
      const h2 = numProp(b.doc, props, "height_m", "height", "building:levels");
      if (h2 !== void 0) n.heightM = h2;
    }
    if (!n.hours && hours) n.hours = hours;
    if (!n.brand && brand) n.brand = brand;
    b.featureIndex.set(f.id, snapped);
    return;
  }
  const partial = { kind, features: [f.id], layer };
  if (name) partial.name = name;
  if (tags.length > 0) partial.tags = tags;
  if (hours) partial.hours = hours;
  if (brand) partial.brand = brand;
  const h = numProp(b.doc, props, "height_m", "height", "building:levels");
  if (h !== void 0) partial.heightM = h;
  const id = addNode(b, partial, p);
  b.featureIndex.set(f.id, id);
  b.used.add(id);
}
__name(compilePoint, "compilePoint");
function nodeKindFor(className) {
  if (TRANSIT_CLASSES.has(className)) return "transit";
  if (className.startsWith("building")) return "building";
  if (className.startsWith("highway") || className.startsWith("railway")) return "intersection";
  if (className.includes("park") || className.includes("garden")) return "park";
  if (className.includes("water") || className.includes("river")) return "water";
  if (POI_CLASSES.has(className) || className.includes(".")) return "poi";
  return "area";
}
__name(nodeKindFor, "nodeKindFor");
var FURNITURE_HIGHWAYS = /* @__PURE__ */ new Set([
  "traffic_signals",
  "crossing",
  "street_lamp",
  "give_way",
  "stop",
  "elevator",
  "turning_circle",
  "milestone",
  "speed_camera",
  "traffic_calming",
  "passing_place",
  "emergency_bay"
]);
var WEAK_POI_CLASSES = /* @__PURE__ */ new Set([
  "tourism.artwork",
  "tourism.viewpoint",
  "tourism.information",
  "tourism.board",
  "tourism.map",
  "amenity.waste_basket",
  "amenity.bicycle_parking",
  "amenity.post_box",
  "amenity.vending_machine",
  "amenity.drinking_water",
  "amenity.bench",
  "amenity.parking_entrance"
]);
function isFurniture(className) {
  const tail = className.split(".")[1] ?? className;
  if (FURNITURE_HIGHWAYS.has(tail)) return true;
  if (WEAK_POI_CLASSES.has(className)) return true;
  return false;
}
__name(isFurniture, "isFurniture");
function isNamed(doc, f) {
  return stringProp(doc, propsOf(doc, f.attrSet), "name") !== void 0;
}
__name(isNamed, "isNamed");
function buildMeta(doc, opts) {
  const c = gridToLonLat({ x: doc.extent / 2, y: doc.extent / 2 }, doc.envelope, doc.extent, doc.projection);
  const meta = {
    center: `${round2(c.lat, 5)}, ${round2(c.lon, 5)}`
  };
  if (opts.radiusLabel) meta.radius = opts.radiusLabel;
  if (doc.meta.lod) meta.lod = doc.meta.lod;
  if (doc.meta.source) meta.source = doc.meta.source;
  if (opts.sun !== false) {
    const sun = sunPosition(c.lat, c.lon, opts.now);
    meta.sun = {
      elevationDeg: sun.elevationDeg,
      daylight: sun.daylight,
      twilight: sun.twilight,
      azimuthDeg: sun.azimuthDeg,
      ...sun.sunrise ? { sunrise: sun.sunrise } : {},
      ...sun.sunset ? { sunset: sun.sunset } : {},
      ...sun.polar ? { polar: sun.polar } : {}
    };
  }
  const omittedTotal = doc.omissions.reduce((a, o) => a + o.count, 0);
  const parts = ["Simplified for reasoning; call expand_feature for exact geometry."];
  if (omittedTotal > 0) {
    parts.push(`Incomplete: ${omittedTotal} feature(s) omitted to fit budget.`);
  }
  meta.note = parts.join(" ");
  return meta;
}
__name(buildMeta, "buildMeta");
function compileHeat(doc, env, maxHotspots) {
  const out = [];
  for (const h of doc.heat) {
    const cells = h.cells ?? [];
    if (cells.length === 0) continue;
    const lo = h.minValue || 0;
    const span = h.maxValue !== lo ? h.maxValue - lo : 0;
    const scale = h.resolution > 0 ? doc.extent / h.resolution : 1;
    const distinct = new Set(cells.map((c) => c.value));
    if (distinct.size === 0) continue;
    if (distinct.size === 1 && (distinct.values().next().value ?? 0) === 0) continue;
    const useful = cells.filter((c) => c.value > 0);
    if (useful.length === 0) continue;
    const plateau = distinct.size === 1;
    const maxHotspotCount = plateau ? 0 : maxHotspots;
    const hotspots = [...useful].sort((a, b) => b.value - a.value).slice(0, maxHotspotCount).map((c) => {
      const ll = gridToLonLat(
        { x: Math.round(c.x * scale), y: Math.round(c.y * scale) },
        env,
        doc.extent,
        doc.projection
      );
      return {
        lat: round2(ll.lat, 5),
        lon: round2(ll.lon, 5),
        value: c.value,
        rel: span > 0 ? round2((c.value - lo) / span, 2) : c.value >= h.maxValue ? 1 : 0
      };
    });
    const seen = /* @__PURE__ */ new Set();
    const deduped = hotspots.filter((s) => {
      const key = `${s.lat},${s.lon}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const outMax = Math.max(...useful.map((c) => c.value));
    const outMean = useful.reduce((a, c) => a + c.value, 0) / useful.length;
    out.push({ name: h.name, max: outMax, mean: round2(outMean, 1), hotspots: deduped });
  }
  return out;
}
__name(compileHeat, "compileHeat");
function compileOmissions(doc) {
  return doc.omissions.map((o) => {
    const layer = doc.layers.get(o.layerId)?.name ?? `layer${o.layerId}`;
    let near = "unspecified";
    if (o.centroid) {
      const c = gridToLonLat(o.centroid, doc.envelope, doc.extent, doc.projection);
      near = `${round2(c.lat, 4)},${round2(c.lon, 4)}`;
    }
    const entry = { layer, count: o.count, near };
    if (o.note !== void 0) {
      const text = doc.strings.get(o.note);
      if (text) entry.note = text;
    }
    return entry;
  });
}
__name(compileOmissions, "compileOmissions");
function propsOf(doc, attrSetId) {
  if (attrSetId === 0) return [];
  return doc.attrSets.get(attrSetId)?.props ?? [];
}
__name(propsOf, "propsOf");
function resolveProp(doc, prop) {
  const v = prop.value;
  switch (v.t) {
    case "ref":
      return doc.strings.get(v.ref) ?? `s${v.ref}`;
    case "num":
      return v.num;
    case "bool":
      return v.bool;
    case "token":
      return v.token;
  }
}
__name(resolveProp, "resolveProp");
function keyName(doc, p) {
  return doc.strings.get(p.key);
}
__name(keyName, "keyName");
function stringProp(doc, props, key) {
  for (const p of props) {
    if (keyName(doc, p) !== key) continue;
    const v = p.value;
    if (v.t === "ref") {
      const s = doc.strings.get(v.ref);
      if (s !== void 0) return s;
    } else if (v.t === "token") {
      return v.token;
    }
  }
  return void 0;
}
__name(stringProp, "stringProp");
function numProp(doc, props, ...keys) {
  for (const p of props) {
    if (!keys.includes(keyName(doc, p) ?? "")) continue;
    if (p.value.t === "num") return p.value.num;
    if (p.value.t === "ref") {
      const s = doc.strings.get(p.value.ref);
      if (s !== void 0) {
        const n = Number(s);
        if (Number.isFinite(n)) return n;
      }
    }
  }
  return void 0;
}
__name(numProp, "numProp");
function hasToken(doc, props, token) {
  for (const p of props) {
    if (p.value.t === "token" && p.value.token === token) return true;
  }
  return false;
}
__name(hasToken, "hasToken");
function isBlocked(props) {
  for (const p of props) {
    if (p.value.t === "token" && BLOCKING_TAGS.has(p.value.token)) return true;
  }
  return false;
}
__name(isBlocked, "isBlocked");
function collectTags(className, props) {
  const tags = [];
  const parts = className.split(".");
  const leaf = parts[parts.length - 1];
  if (leaf && leaf !== className) tags.push(leaf);
  for (const p of props) {
    if (p.value.t === "token" && !BLOCKING_TAGS.has(p.value.token)) tags.push(p.value.token);
  }
  return dedupe(tags).slice(0, 4);
}
__name(collectTags, "collectTags");
function classPathHint(className, layerName) {
  for (const { match, path } of PATH_HINTS) {
    if (className.includes(match)) return path;
  }
  if (layerName === "road") return "road";
  return void 0;
}
__name(classPathHint, "classPathHint");
function dedupe(items) {
  return [...new Set(items)];
}
__name(dedupe, "dedupe");
function round2(n, places) {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}
__name(round2, "round");
function pruneIsolated(b) {
  b.nodes = b.nodes.filter((n) => b.used.has(n.id) || n.name !== void 0);
}
__name(pruneIsolated, "pruneIsolated");
function attachStrandedLandmarks(b) {
  const degree = /* @__PURE__ */ new Map();
  for (const e of b.edges) {
    degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
    degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
  }
  const backbone = /* @__PURE__ */ new Set();
  for (const [id, d] of degree) if (d >= 2) backbone.add(id);
  for (const node of b.nodes) {
    if (node.name === void 0) continue;
    if ((degree.get(node.id) ?? 0) > 0) continue;
    const at = b.anchors.get(node.id);
    if (!at) continue;
    const near = nearestNode(b, at, backbone, node.id);
    if (near === void 0) continue;
    addEdge(b, near, node.id, "access", false, false, node.features[0] ?? 0);
    b.pinned.add(node.id);
  }
}
__name(attachStrandedLandmarks, "attachStrandedLandmarks");
function allNodes(b) {
  return new Set(b.anchors.keys());
}
__name(allNodes, "allNodes");
function nearestNode(b, at, candidates, exclude) {
  let best;
  let bestDist = Infinity;
  for (const id of candidates) {
    if (id === exclude) continue;
    const anchor = b.anchors.get(id);
    if (!anchor) continue;
    const d = Math.hypot(anchor.x - at.x, anchor.y - at.y);
    if (d < bestDist) {
      bestDist = d;
      best = id;
    }
  }
  return best;
}
__name(nearestNode, "nearestNode");

// ../../src/emit/yaml.ts
function estimateTokens(text) {
  if (text.length === 0) return 0;
  return Math.ceil(text.length / 4);
}
__name(estimateTokens, "estimateTokens");
function yamlString(value) {
  if (value === "") return '""';
  const needsQuote = /^[\s]|[\s]$/.test(value) || /[:#\[\]{}&*!|>'"%@`,]/.test(value) || /^(true|false|null|yes|no|on|off|~)$/i.test(value) || /^-?\d+(\.\d+)?$/.test(value) || value === "-" || value === "...";
  return needsQuote ? `"${value.replace(/"/g, '\\"')}"` : value;
}
__name(yamlString, "yamlString");
function valueWithHash(value) {
  return /^\s*#| #/.test(value) ? yamlString(value) : value;
}
__name(valueWithHash, "valueWithHash");
function emitGraph(graph, opts = {}) {
  const scale = opts.scale;
  const out = [];
  out.push("map:");
  out.push(`  center: ${yamlString(graph.meta.center)}`);
  if (graph.meta.radius) out.push(`  radius: ${yamlString(graph.meta.radius)}`);
  if (graph.meta.lod) out.push(`  lod: ${yamlString(graph.meta.lod)}`);
  if (graph.meta.source) out.push(`  source: ${yamlString(graph.meta.source)}`);
  if (graph.meta.sun) {
    const s = graph.meta.sun;
    const parts = [
      `sun: ${s.daylight ? "up" : "down"}`,
      `elevation: ${s.elevationDeg}deg`,
      `twilight: ${s.twilight}`,
      `azimuth: ${s.azimuthDeg}deg`
    ];
    if (s.polar) parts.push(`polar: ${s.polar}`);
    else {
      if (s.sunrise) parts.push(`sunrise: ${yamlString(s.sunrise)}`);
      if (s.sunset) parts.push(`sunset: ${yamlString(s.sunset)}`);
    }
    out.push(`  ${parts.join(", ")}`);
  }
  if (graph.meta.note) out.push(`  note: ${yamlString(graph.meta.note)}`);
  out.push("nodes:");
  if (graph.nodes.length === 0) {
    out.push("  {}");
  } else {
    for (const n of graph.nodes) out.push(`  ${n.id}: ${nodeBody(n)}`);
  }
  out.push("edges:");
  if (graph.edges.length === 0) {
    out.push("  {}");
  } else {
    for (const e of graph.edges) out.push(`  ${e.from}->${e.to}: ${edgeBody(e, scale)}`);
  }
  if (graph.obstacles.length > 0) {
    out.push("obstacles:");
    for (const o of graph.obstacles) {
      const parts = [`edge: ${yamlString(o.edge)}`, `type: ${yamlString(o.type)}`];
      if (o.blocks) parts.push("blocks: true");
      out.push(`  - {${parts.join(", ")}}`);
    }
  }
  if (opts.includeHeat !== false && graph.heat.length > 0) {
    out.push("heat:");
    for (const h of graph.heat) {
      out.push(`  ${yamlString(h.name)}: {max: ${h.max}, mean: ${h.mean}}`);
      for (const spot of h.hotspots) {
        out.push(
          `    - {at: "${spot.lat},${spot.lon}", v: ${spot.value}, rel: ${spot.rel}}`
        );
      }
    }
  }
  if (opts.includeIndoor !== false && isMeaningfulIndoor(graph.indoor)) {
    out.push(...indoorLines(graph.indoor));
  }
  if (opts.includeOmitted !== false && graph.omitted.length > 0) {
    out.push("omitted:");
    for (const o of graph.omitted) {
      const parts = [`layer: ${yamlString(o.layer)}`, `count: ${o.count}`];
      if (o.near !== "unspecified") parts.push(`near: ${yamlString(o.near)}`);
      if (o.note) parts.push(`note: ${yamlString(o.note)}`);
      out.push(`  - {${parts.join(", ")}}`);
    }
  }
  if (opts.includeTools !== false && graph.tools.length > 0) {
    out.push("tools:");
    for (const t of graph.tools) out.push(`  - ${t}`);
  }
  const yaml = out.join("\n") + "\n";
  return { yaml, tokens: estimateTokens(yaml), chars: yaml.length };
}
__name(emitGraph, "emitGraph");
function indoorLines(graph) {
  const out = ["indoor:"];
  out.push(`  storeys: ${graph.levels.map((l) => l.level).join(",") || "none"}`);
  out.push(`  ${graph.multiStorey ? "multi_storey: true" : "multi_storey: false"}`);
  for (const level of graph.levels) {
    out.push(`  ${level.level}: {label: ${yamlString(level.label)}, rooms: ${level.nodes.length}}`);
    for (const n of level.nodes) {
      const parts = [`type: ${n.kind}`];
      if (n.name) parts.push(`name: ${yamlString(n.name)}`);
      if (n.wheelchair !== void 0) parts.push(`wheelchair: ${n.wheelchair}`);
      out.push(`    ${n.id}: {${parts.join(", ")}}`);
    }
    for (const e of level.edges) {
      const parts = [`dist: ${e.distM}m`];
      if (e.blocked) parts.push("blocked: true");
      if (e.door) parts.push(`door: ${yamlString(e.door)}`);
      out.push(`    ${e.from}->${e.to}: {${parts.join(", ")}}`);
    }
  }
  for (const v of graph.vertical) {
    const parts = [`type: ${v.kind}`, `levels: [${v.levels.join(",")}]`];
    if (v.wheelchair) parts.push("wheelchair: true");
    if (v.name) parts.push(`name: ${yamlString(v.name)}`);
    out.push(`  ${v.id}: {${parts.join(", ")}}`);
  }
  if (graph.missingLevels.length > 0) {
    out.push(`  missing: [${graph.missingLevels.join(",")}]`);
  }
  for (const o of graph.omitted) {
    out.push(`  omitted: - {level: ${o.level}, note: ${yamlString(o.reason)}}`);
  }
  return out;
}
__name(indoorLines, "indoorLines");
function nodeBody(n) {
  const parts = [];
  parts.push(`type: ${n.kind}`);
  if (n.name) parts.push(`name: ${yamlString(n.name)}`);
  if (n.tags && n.tags.length > 0) {
    parts.push(`tags: [${n.tags.map(yamlString).join(", ")}]`);
  }
  if (n.heightM !== void 0) parts.push(`height: ${n.heightM}m`);
  if (n.hours) parts.push(`hours: ${valueWithHash(n.hours)}`);
  if (n.brand) parts.push(`brand: ${yamlString(n.brand)}`);
  if (n.lat !== void 0 && n.lon !== void 0) {
    parts.push(`at: "${n.lat},${n.lon}"`);
  }
  return `{${parts.join(", ")}}`;
}
__name(nodeBody, "nodeBody");
function edgeBody(e, scale) {
  const parts = [];
  const usableScale = scale && Number.isFinite(scale.x) && Number.isFinite(scale.y) ? scale : void 0;
  const metres = usableScale ? (e.segments ?? [e]).reduce((sum, leg) => sum + Math.hypot(leg.dx * usableScale.x, leg.dy * usableScale.y), 0) : Number.NaN;
  if (Number.isFinite(metres)) {
    parts.push(`dist: ${Math.round(metres)}m`);
  } else if (Number.isFinite(e.dist)) {
    parts.push(`dist: ${Math.round(e.dist)}u`);
  } else {
    parts.push("dist: unknown");
  }
  parts.push(`dir: ${e.dir}`);
  if (e.path) parts.push(`path: ${e.path}`);
  if (e.crosswalk) parts.push("crosswalk: true");
  if (e.blocked) parts.push("blocked: true");
  return `{${parts.join(", ")}}`;
}
__name(edgeBody, "edgeBody");

// ../../src/budget/budget.ts
var DEFAULT_OVERHEAD = 0.12;
var DEFAULT_LANDMARKS_PER_TOKEN = 100;
function fitToBudget(graph, opts) {
  const budget = Math.max(64, opts.budget);
  const overhead = Math.floor(budget * (opts.overheadFraction ?? DEFAULT_OVERHEAD));
  const target = budget - overhead;
  const minLandmarks = opts.minLandmarks ?? Math.max(
    4,
    Math.round(budget / DEFAULT_LANDMARKS_PER_TOKEN)
  );
  const nodes = [...graph.nodes];
  const edges = [...graph.edges];
  const omissions = [...graph.omitted];
  const landmarks = new Set(graph.pinned);
  let droppedNodes = 0;
  let droppedEdges = 0;
  const recordOmission = /* @__PURE__ */ __name((layer, count) => {
    const existing = omissions.find((o) => o.layer === layer);
    if (existing) existing.count += count;
    else omissions.push({ layer, count, near: "unspecified" });
  }, "recordOmission");
  const byId = new Map(nodes.map((n) => [n.id, n]));
  contractAnonymousChains(nodes, edges, (removed) => {
    droppedNodes += removed;
    recordOmission("waypoint", removed);
  });
  const ranked = rankNodes(nodes, edges);
  const keep = /* @__PURE__ */ new Set();
  for (const node of ranked) keep.add(node.id);
  let current = estimateGraphTokens(nodes, edges, graph);
  let guard = 0;
  let batch = Math.max(1, Math.floor(nodes.length / 8));
  let stalls = 0;
  let allowCuts = false;
  while (current > target && guard++ < 2e3) {
    const cuts = articulationPoints(nodes, edges, keep);
    const liveNamed = nodes.filter((n) => keep.has(n.id) && n.name !== void 0).length;
    const removableNamed = /* @__PURE__ */ new Set();
    {
      let allowance = liveNamed - minLandmarks;
      for (let i = ranked.length - 1; i >= 0 && allowance > 0; i--) {
        const n = ranked[i];
        if (keep.has(n.id) && n.name !== void 0 && !removableNamed.has(n.id)) {
          removableNamed.add(n.id);
          allowance--;
        }
      }
    }
    const remove = /* @__PURE__ */ new Set();
    let namedLeft = liveNamed;
    let liveEdgeCount = 0;
    for (const e of edges) if (keep.has(e.from) && keep.has(e.to)) liveEdgeCount++;
    const collect = /* @__PURE__ */ __name((allowCuts2) => {
      for (let i = ranked.length - 1; i >= 0; i--) {
        const n = ranked[i];
        if (remove.size >= batch) return;
        if (!keep.has(n.id) || remove.has(n.id)) continue;
        if (!allowCuts2 && cuts.has(n.id)) continue;
        if (liveEdgeCount >= 2 && liveEdgeCount - incidentCount(edges, n.id) < 2) continue;
        if (n.name !== void 0) {
          if (namedLeft <= minLandmarks) continue;
          namedLeft--;
        }
        if (wouldOrphanLandmark(edges, n.id, landmarks, keep)) continue;
        remove.add(n.id);
        keep.delete(n.id);
        liveEdgeCount -= incidentCount(edges, n.id);
      }
    }, "collect");
    collect(false);
    if (remove.size < batch && allowCuts) collect(true);
    for (const id of remove) keep.add(id);
    if (remove.size === 0) {
      if (batch > 1 || !allowCuts) {
        batch = Math.floor(batch / 2);
        if (++stalls > 8) break;
        if (batch === 1 && !allowCuts && current > budget + overhead) {
          allowCuts = true;
          stalls = 0;
        }
        continue;
      }
      break;
    }
    const edgesBefore = edges.length;
    const applied2 = applyRemovalsValidated([...remove], nodes, edges, keep, landmarks, removableNamed, !allowCuts);
    if (applied2.size === 0) {
      if (batch > 1) {
        batch = Math.floor(batch / 2);
        if (++stalls > 8) break;
        continue;
      }
      break;
    }
    droppedNodes += applied2.size;
    droppedEdges = Math.max(droppedEdges, edgesBefore - edges.length);
    for (const id of applied2) {
      recordOmission(byId.get(id)?.layer ?? "feature", 1);
    }
    current = estimateGraphTokens(nodes, edges, graph);
    if (applied2.size >= batch) {
      batch = Math.min(nodes.length, batch + Math.max(1, Math.floor(batch / 4)));
      stalls = 0;
    } else {
      batch = Math.max(1, Math.min(batch, applied2.size * 2));
      stalls = 0;
    }
  }
  if (droppedNodes > 0) {
    const holders = /* @__PURE__ */ new Set();
    for (const e of edges) {
      if (landmarks.has(e.to)) holders.add(e.from);
      if (landmarks.has(e.from)) holders.add(e.to);
    }
    contractAnonymousChains(nodes, edges, (removed) => {
      droppedNodes += removed;
      recordOmission("waypoint", removed);
    }, holders);
  }
  const finalGraph = {
    ...graph,
    nodes,
    edges,
    omitted: omissions,
    pinned: [...landmarks],
    partial: graph.partial || droppedNodes > 0 || droppedEdges > 0
  };
  const applied = droppedNodes > 0 || droppedEdges > 0;
  if (opts.alwaysReportOmissions !== false && !applied) {
    finalGraph.omitted = omissions;
  }
  return { graph: finalGraph, tokens: current, droppedNodes, droppedEdges, applied };
}
__name(fitToBudget, "fitToBudget");
function scoreNode(node, degree, maxDegree) {
  let score = 0;
  if (node.name) score += 100;
  if (node.kind === "transit") score += 40;
  if (node.kind === "poi") score += 30;
  if (node.kind === "building") score += 20;
  if (node.kind === "entrance") score += 20;
  if (node.tags && node.tags.length > 0) score += 10;
  if (node.heightM !== void 0) score += 5;
  score += maxDegree > 0 ? degree / maxDegree * 25 : 0;
  return score;
}
__name(scoreNode, "scoreNode");
function rankNodes(nodes, edges) {
  const degrees = degreeMap(nodes, edges);
  const inNetwork = nodesInMainComponent(nodes, edges);
  const networkKinds = /* @__PURE__ */ new Set(["intersection"]);
  let maxDegree = 0;
  for (const d of degrees.values()) if (d > maxDegree) maxDegree = d;
  return [...nodes].sort((a, b) => {
    const sa = scoreNode(a, degrees.get(a.id) ?? 0, maxDegree);
    const sb = scoreNode(b, degrees.get(b.id) ?? 0, maxDegree);
    const na = inNetwork.has(a.id) ? 1 : 0;
    const nb = inNetwork.has(b.id) ? 1 : 0;
    if (na !== nb) return nb - na;
    const tier = /* @__PURE__ */ __name((n) => {
      if (networkKinds.has(n.kind)) return 1;
      if (n.name !== void 0) return 2;
      return 0;
    }, "tier");
    const ta = tier(a);
    const tb = tier(b);
    if (ta !== tb) return tb - ta;
    return sb - sa;
  });
}
__name(rankNodes, "rankNodes");
function nodesInMainComponent(nodes, edges) {
  const adj = /* @__PURE__ */ new Map();
  for (const n of nodes) adj.set(n.id, /* @__PURE__ */ new Set());
  for (const e of edges) {
    if (e.from === e.to) continue;
    adj.get(e.from)?.add(e.to);
    adj.get(e.to)?.add(e.from);
  }
  const weight = /* @__PURE__ */ __name((id) => {
    const node = nodes.find((n) => n.id === id);
    return node?.kind === "intersection" ? 10 : 1;
  }, "weight");
  let best = [];
  let bestScore = -1;
  const seen = /* @__PURE__ */ new Set();
  for (const n of nodes) {
    if (seen.has(n.id)) continue;
    const component = [];
    const stack = [n.id];
    seen.add(n.id);
    let score = 0;
    while (stack.length > 0) {
      const id = stack.pop();
      component.push(id);
      score += weight(id);
      for (const nb of adj.get(id) ?? []) {
        if (seen.has(nb)) continue;
        seen.add(nb);
        stack.push(nb);
      }
    }
    if (score > bestScore) {
      bestScore = score;
      best = component;
    }
  }
  return new Set(best);
}
__name(nodesInMainComponent, "nodesInMainComponent");
function degreeMap(nodes, edges) {
  const degrees = /* @__PURE__ */ new Map();
  for (const n of nodes) degrees.set(n.id, 0);
  for (const e of edges) {
    degrees.set(e.from, (degrees.get(e.from) ?? 0) + 1);
    degrees.set(e.to, (degrees.get(e.to) ?? 0) + 1);
  }
  return degrees;
}
__name(degreeMap, "degreeMap");
function incidentCount(edges, id) {
  let n = 0;
  for (const e of edges) {
    if (e.from === id || e.to === id) n++;
  }
  return n;
}
__name(incidentCount, "incidentCount");
function wouldOrphanLandmark(edges, id, landmarks, keep) {
  const neighbours = touchingIds(edges, id).filter((o) => keep.has(o));
  return neighbours.some((other) => {
    if (!landmarks.has(other)) return false;
    const surviving = touchingIds(edges, other).filter(
      (o) => o !== id && keep.has(o)
    ).length;
    return surviving === 0;
  });
}
__name(wouldOrphanLandmark, "wouldOrphanLandmark");
function touchingIds(edges, id) {
  const out = [];
  for (const e of edges) {
    if (e.from === id) out.push(e.to);
    else if (e.to === id) out.push(e.from);
  }
  return out;
}
__name(touchingIds, "touchingIds");
function articulationPoints(nodes, edges, keep) {
  const live = nodes.filter((n) => keep.has(n.id));
  const adj = /* @__PURE__ */ new Map();
  for (const n of live) adj.set(n.id, /* @__PURE__ */ new Set());
  for (const e of edges) {
    if (!keep.has(e.from) || !keep.has(e.to)) continue;
    if (e.from === e.to) continue;
    adj.get(e.from)?.add(e.to);
    adj.get(e.to)?.add(e.from);
  }
  const disc = /* @__PURE__ */ new Map();
  const low = /* @__PURE__ */ new Map();
  const parent = /* @__PURE__ */ new Map();
  const cuts = /* @__PURE__ */ new Set();
  let clock = 0;
  const childCounts = /* @__PURE__ */ new Map();
  for (const root of live) {
    if (disc.has(root.id)) continue;
    const stack = [
      { id: root.id, iter: adj.get(root.id)[Symbol.iterator]() }
    ];
    disc.set(root.id, clock);
    low.set(root.id, clock);
    clock++;
    parent.set(root.id, void 0);
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      const next = frame.iter.next();
      if (next.done) {
        stack.pop();
        const p = parent.get(frame.id);
        if (p !== void 0) {
          const childLow = low.get(frame.id);
          const parentLow = low.get(p);
          if (childLow < parentLow) low.set(p, childLow);
          if (parent.get(p) !== void 0 && childLow >= disc.get(p)) cuts.add(p);
        }
        if (p === void 0 && (childCounts.get(frame.id) ?? 0) > 1) cuts.add(frame.id);
        continue;
      }
      const v = next.value;
      if (v === parent.get(frame.id)) continue;
      if (disc.has(v)) {
        const dv = disc.get(v);
        if (dv < low.get(frame.id)) low.set(frame.id, dv);
        continue;
      }
      childCounts.set(frame.id, (childCounts.get(frame.id) ?? 0) + 1);
      parent.set(v, frame.id);
      disc.set(v, clock);
      low.set(v, clock);
      clock++;
      stack.push({ id: v, iter: adj.get(v)[Symbol.iterator]() });
    }
  }
  return cuts;
}
__name(articulationPoints, "articulationPoints");
function componentCount(nodes, edges) {
  const adj = /* @__PURE__ */ new Map();
  for (const n of nodes) adj.set(n.id, []);
  for (const e of edges) {
    if (e.from === e.to) continue;
    adj.get(e.from)?.push(e.to);
    adj.get(e.to)?.push(e.from);
  }
  const seen = /* @__PURE__ */ new Set();
  let count = 0;
  for (const n of nodes) {
    if (seen.has(n.id)) continue;
    count++;
    const stack = [n.id];
    seen.add(n.id);
    while (stack.length > 0) {
      const id = stack.pop();
      for (const nb of adj.get(id) ?? []) {
        if (!seen.has(nb)) {
          seen.add(nb);
          stack.push(nb);
        }
      }
    }
  }
  return count;
}
__name(componentCount, "componentCount");
function applyRemovalsValidated(candidates, nodes, edges, keep, landmarks, removableNamed = /* @__PURE__ */ new Set(), enforceConnectivity = false) {
  return applySafe([...new Set(candidates)]);
  function applySafe(batch) {
    for (let pass = 0; pass <= landmarks.size; pass++) {
      const batchSet2 = new Set(batch);
      const inKeep = /* @__PURE__ */ __name((id) => keep.has(id) && !batchSet2.has(id), "inKeep");
      const liveNodes2 = nodes.filter((n) => inKeep(n.id));
      const liveEdges2 = edges.filter((e) => inKeep(e.from) && inKeep(e.to));
      const stranded = [];
      for (const n of liveNodes2) {
        if (!landmarks.has(n.id)) continue;
        if (!liveEdges2.some((e) => e.from === n.id || e.to === n.id)) stranded.push(n.id);
      }
      if (stranded.length === 0) break;
      if (pass === landmarks.size) return /* @__PURE__ */ new Set();
      for (const id of stranded) {
        if (removableNamed.has(id)) {
          batch.push(id);
        } else {
          for (let i = batch.length - 1; i >= 0; i--) {
            const c = batch[i];
            if (edges.some((e) => e.from === id && e.to === c || e.to === id && e.from === c)) {
              batch.splice(i, 1);
            }
          }
        }
      }
    }
    if (batch.length === 0) return /* @__PURE__ */ new Set();
    const batchSet = new Set(batch);
    const liveNodes = nodes.filter((n) => keep.has(n.id) && !batchSet.has(n.id));
    const liveEdges = edges.filter((e) => keep.has(e.from) && keep.has(e.to) && !batchSet.has(e.from) && !batchSet.has(e.to));
    if (enforceConnectivity) {
      const before = componentCount(nodes, edges);
      const isolatedRemoved = batch.filter((id) => {
        const node = nodes.find((n) => n.id === id);
        if (!node) return false;
        return !edges.some((e) => (e.from === id || e.to === id) && keep.has(e.from) && keep.has(e.to));
      }).length;
      const split = componentCount(liveNodes, liveEdges) > before - isolatedRemoved;
      if (split) {
        if (batch.length === 1) return /* @__PURE__ */ new Set();
        const mid = batch.length >> 1;
        return /* @__PURE__ */ new Set([
          ...applySafe(batch.slice(0, mid)),
          ...applySafe(batch.slice(mid))
        ]);
      }
    }
    for (const id of batch) keep.delete(id);
    nodes.length = 0;
    nodes.push(...liveNodes);
    edges.length = 0;
    edges.push(...liveEdges);
    return batchSet;
  }
  __name(applySafe, "applySafe");
}
__name(applyRemovalsValidated, "applyRemovalsValidated");
function contractAnonymousChains(nodes, edges, onRemove, protectedIds) {
  let removed = 0;
  const uncontractable = /* @__PURE__ */ new Set();
  for (; ; ) {
    const neighbourCount = distinctNeighbourMap(nodes, edges);
    const victim = nodes.find(
      (n) => !n.name && !uncontractable.has(n.id) && n.kind === "intersection" && !protectedIds?.has(n.id) && (neighbourCount.get(n.id) ?? 0) === 2
    );
    if (victim === void 0) break;
    const inbound = edges.filter((e) => e.to === victim.id);
    const outbound = edges.filter((e) => e.from === victim.id);
    if (inbound.length !== 2 || outbound.length !== 2) {
      uncontractable.add(victim.id);
      continue;
    }
    const before = new Set(inbound.map((e) => e.from));
    const after = new Set(outbound.map((e) => e.to));
    if (before.size !== 2 || after.size !== 2 || [...before].some((id) => !after.has(id))) {
      uncontractable.add(victim.id);
      continue;
    }
    const neighbours = [...before];
    const beforeId = neighbours[0];
    const afterId = neighbours[1];
    if (beforeId === afterId) break;
    const inLeg = inbound.find((e) => e.from === beforeId);
    const outLeg = outbound.find((e) => e.to === afterId);
    const sameAttributes = [...inbound, ...outbound].every((e) => e.path === inLeg.path && !!e.blocked === !!inLeg.blocked && !!e.crosswalk === !!inLeg.crosswalk);
    const duplicate = edges.some((e) => e.from === beforeId && e.to === afterId || e.from === afterId && e.to === beforeId);
    if (!sameAttributes || duplicate || inLeg.blocked) {
      uncontractable.add(victim.id);
      continue;
    }
    const dx = inLeg.dx + outLeg.dx;
    const dy = inLeg.dy + outLeg.dy;
    const dist = inLeg.dist + outLeg.dist;
    const segments = [...inLeg.segments ?? [{ dx: inLeg.dx, dy: inLeg.dy }], ...outLeg.segments ?? [{ dx: outLeg.dx, dy: outLeg.dy }]];
    const bearing2 = compassOf({ x: 0, y: 0 }, { x: dx, y: dy });
    const features = dedupe2([...inLeg.features, ...outLeg.features]);
    const forward = {
      from: beforeId,
      to: afterId,
      dist,
      dx,
      dy,
      dir: bearing2,
      segments,
      features
    };
    const reverse = {
      from: afterId,
      to: beforeId,
      dist,
      dx: -dx,
      dy: -dy,
      dir: oppositeCompass(bearing2),
      segments: [...segments].reverse().map((s) => ({ dx: -s.dx, dy: -s.dy })),
      features
    };
    const p = inLeg.path ?? outLeg.path;
    if (p) {
      forward.path = p;
      reverse.path = p;
    }
    if (inLeg.crosswalk) {
      forward.crosswalk = true;
      reverse.crosswalk = true;
    }
    if (inLeg.blocked) {
      forward.blocked = true;
      reverse.blocked = true;
    }
    for (let i = edges.length - 1; i >= 0; i--) {
      const e = edges[i];
      if (e.from === victim.id || e.to === victim.id) edges.splice(i, 1);
    }
    edges.push(forward, reverse);
    const ni = nodes.findIndex((n) => n.id === victim.id);
    nodes.splice(ni, 1);
    removed++;
  }
  if (removed > 0) onRemove?.(removed);
  return removed;
}
__name(contractAnonymousChains, "contractAnonymousChains");
function distinctNeighbourMap(nodes, edges) {
  const sets = /* @__PURE__ */ new Map();
  for (const n of nodes) sets.set(n.id, /* @__PURE__ */ new Set());
  for (const e of edges) {
    sets.get(e.from)?.add(e.to);
    sets.get(e.to)?.add(e.from);
  }
  const out = /* @__PURE__ */ new Map();
  for (const [id, s] of sets) out.set(id, s.size);
  return out;
}
__name(distinctNeighbourMap, "distinctNeighbourMap");
function estimateGraphTokens(nodes, edges, graph) {
  const nodeChars = nodes.length * 28;
  const edgeChars = edges.length * 46;
  const overheadChars = 120 + graph.obstacles.length * 40 + graph.omitted.length * 40 + graph.heat.length * 60;
  return Math.ceil((nodeChars + edgeChars + overheadChars) / 4);
}
__name(estimateGraphTokens, "estimateGraphTokens");
function dedupe2(items) {
  return [...new Set(items)];
}
__name(dedupe2, "dedupe");

// ../../src/geo/scale.ts
function gridScaleFor(doc) {
  const env = mercEnvelope(doc.envelope, doc.projection);
  const widthM = env.maxX - env.minX;
  const heightM = Math.abs(env.bottomY - env.topY);
  if (!Number.isFinite(widthM) || !Number.isFinite(heightM)) return void 0;
  if (widthM <= 0 || heightM <= 0) return void 0;
  if (doc.extent <= 0) return void 0;
  const centre = gridToLonLat(
    { x: doc.extent / 2, y: doc.extent / 2 },
    doc.envelope,
    doc.extent,
    doc.projection
  );
  const latCorrection = Math.cos(centre.lat * Math.PI / 180);
  if (!Number.isFinite(latCorrection) || latCorrection <= 0) return void 0;
  return {
    x: widthM / doc.extent * latCorrection,
    y: heightM / doc.extent * latCorrection
  };
}
__name(gridScaleFor, "gridScaleFor");

// ../../src/pipeline.ts
var wireTextEncoder = new TextEncoder();
function toMaplet(input, req = {}) {
  const envelope = req.envelope ?? (req.bbox ? { type: "bbox", ...req.bbox } : void 0);
  let doc = req.doc ?? fromGeoJson(input, { ...req.ingest, ...envelope ? { envelope } : {} });
  if (req.layers && req.layers.length > 0) {
    doc = filterLayers(doc, new Set(req.layers));
  }
  const scr = encodeDocument(doc, { group: false });
  const graph = compile(doc, {
    ...req.compile,
    ...req.radiusLabel ? { radiusLabel: req.radiusLabel } : {},
    capabilities: req.capabilities ?? { elevation: req.hasElevation ?? false, weather: false, traffic: false }
  });
  const budget = req.budget ?? 1024;
  const fitted = fitToBudget(graph, { ...req.budgetOpts, budget });
  const scale = gridScaleFor(doc);
  const layers = req.layers ?? [];
  const poiOnly = layers.length > 0 && !layers.some((l) => l === "road" || l === "highway");
  const emitted = emitAndVerify(
    fitted,
    poiOnly ? { ...req.emit, keepOrphans: true } : req.emit,
    scale,
    budget
  );
  return {
    doc,
    scr,
    graph: emitted.graph,
    yaml: emitted.result.yaml,
    metrics: {
      budget,
      tokens: emitted.result.tokens,
      wireBytes: wireTextEncoder.encode(scr).length,
      wireTokens: Math.ceil(wireTextEncoder.encode(scr).length / 4),
      yamlTokens: emitted.result.tokens,
      nodes: emitted.graph.nodes.length,
      edges: emitted.graph.edges.length,
      droppedNodes: emitted.dropped,
      droppedEdges: 0
    }
  };
}
__name(toMaplet, "toMaplet");
function pruneStaleObstacles(graph) {
  const alive = new Set(graph.edges.map((e) => `${e.from}->${e.to}`));
  if (graph.obstacles.every((o) => alive.has(o.edge))) return graph;
  return { ...graph, obstacles: graph.obstacles.filter((o) => alive.has(o.edge)) };
}
__name(pruneStaleObstacles, "pruneStaleObstacles");
function emitAndVerify(fitted, emitOpts, scale, budget) {
  const render = /* @__PURE__ */ __name((g) => emitGraph(g, { ...emitOpts, scale: emitOpts?.scale ?? scale }), "render");
  let graph = pruneStaleObstacles(fitted.graph);
  let result = render(graph);
  let dropped = fitted.droppedNodes;
  let batch = Math.max(1, Math.min(8, Math.floor(graph.nodes.length / 40)));
  let stalls = 0;
  let allowCuts = false;
  for (let guard = 0; guard < 3e3 && result.tokens > budget; guard++) {
    if (graph.nodes.length <= 2) break;
    if (graph.edges.length === 2) break;
    const holding = junctionsHoldingLandmarks(graph);
    const cap = graph.edges.length < 2 ? batch : Math.max(1, Math.min(batch, graph.nodes.length - 3, graph.edges.length - 2));
    const named = new Set(
      graph.nodes.filter((n) => n.name !== void 0).map((n) => n.id)
    );
    const victims = pickBatch(graph, holding, cap, allowCuts).filter(
      (id) => graph.edges.length >= 2 || !named.has(id)
    );
    if (victims.length === 0) {
      if (batch > 1) {
        batch = Math.floor(batch / 2);
        stalls++;
        if (stalls > 6) break;
        if (batch === 1 && !allowCuts) {
          allowCuts = true;
          stalls = 0;
        }
        continue;
      }
      if (!allowCuts) {
        allowCuts = true;
        stalls = 0;
        continue;
      }
      break;
    }
    const remove = new Set(victims);
    graph = {
      ...graph,
      nodes: graph.nodes.filter((n) => !remove.has(n.id)),
      edges: graph.edges.filter((e) => !remove.has(e.from) && !remove.has(e.to)),
      omitted: bumpOmission(graph.omitted, "landmark", victims.length),
      partial: true
    };
    dropped += victims.length;
    contractAnonymousChains(graph.nodes, graph.edges, (count) => {
      dropped += count;
      graph = { ...graph, omitted: bumpOmission(graph.omitted, "waypoint", count), partial: true };
    }, junctionsHoldingLandmarks(graph));
    graph = pruneStaleObstacles(graph);
    result = render(graph);
    if (victims.length >= batch) {
      batch = Math.min(graph.nodes.length, batch + Math.max(1, Math.floor(batch / 4)));
      stalls = 0;
    } else {
      batch = Math.max(1, victims.length);
      stalls = 0;
    }
  }
  if (!emitOpts?.keepOrphans) {
    const touched = /* @__PURE__ */ new Set();
    for (const e of graph.edges) {
      touched.add(e.from);
      touched.add(e.to);
    }
    const orphans = graph.nodes.filter(
      (n) => n.name !== void 0 && !touched.has(n.id)
    );
    if (orphans.length > 0) {
      const remove = new Set(orphans.map((n) => n.id));
      graph = {
        ...graph,
        nodes: graph.nodes.filter((n) => !remove.has(n.id)),
        edges: graph.edges.filter((e) => !remove.has(e.from) && !remove.has(e.to)),
        omitted: bumpOmission(graph.omitted, "landmark", orphans.length),
        partial: true
      };
      dropped += orphans.length;
      result = render(graph);
    }
  }
  return { graph, result, dropped };
}
__name(emitAndVerify, "emitAndVerify");
function pickBatch(graph, skip, limit, allowCuts = false) {
  const incident = /* @__PURE__ */ new Map();
  for (const e of graph.edges) {
    incident.set(e.from, (incident.get(e.from) ?? 0) + 1);
    incident.set(e.to, (incident.get(e.to) ?? 0) + 1);
  }
  const keep = new Set(graph.nodes.map((n) => n.id));
  const cuts = articulationPoints(graph.nodes, graph.edges, keep);
  let edgesLeft = graph.edges.length;
  const scored = graph.nodes.map((n) => ({
    id: n.id,
    tier: (n.name !== void 0 ? 2 : 0) + (cuts.has(n.id) ? 1 : 0),
    score: (n.name !== void 0 ? 1e3 : 0) + landmarkScore(n)
  }));
  scored.sort((a, b) => a.tier - b.tier || a.score - b.score);
  const candidates = [];
  for (const { id, tier } of scored) {
    if (candidates.length >= limit) break;
    if (!allowCuts && tier >= 1) break;
    if (skip.has(id)) continue;
    const cost = incident.get(id) ?? 0;
    if (edgesLeft >= 2 && edgesLeft - cost < 2) continue;
    candidates.push(id);
    keep.delete(id);
    edgesLeft -= cost;
  }
  const namedIds = new Set(graph.nodes.filter((n) => n.name !== void 0).map((n) => n.id));
  const scratchNodes = [...graph.nodes];
  const scratchEdges = [...graph.edges];
  const scratchKeep = new Set(graph.nodes.map((n) => n.id));
  const applied = applyRemovalsValidated(candidates, scratchNodes, scratchEdges, scratchKeep, namedIds, namedIds, !allowCuts);
  return candidates.filter((id) => applied.has(id));
}
__name(pickBatch, "pickBatch");
function bumpOmission(omitted, layer, count = 1) {
  const existing = omitted.find((o) => o.layer === layer);
  if (existing) {
    return omitted.map((o) => o === existing ? { ...o, count: o.count + count } : o);
  }
  return [...omitted, { layer, count, near: "unspecified" }];
}
__name(bumpOmission, "bumpOmission");
function junctionsHoldingLandmarks(graph) {
  const degree = /* @__PURE__ */ new Map();
  for (const n of graph.nodes) degree.set(n.id, 0);
  for (const e of graph.edges) {
    degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
    degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
  }
  const named = new Set(
    graph.nodes.filter((n) => n.name !== void 0).map((n) => n.id)
  );
  const holding = /* @__PURE__ */ new Set();
  for (const e of graph.edges) {
    if (named.has(e.to) && (degree.get(e.to) ?? 0) <= 2) holding.add(e.from);
    if (named.has(e.from) && (degree.get(e.from) ?? 0) <= 2) holding.add(e.to);
  }
  return holding;
}
__name(junctionsHoldingLandmarks, "junctionsHoldingLandmarks");
function landmarkScore(n) {
  let score = 0;
  if (n.heightM !== void 0) score += 2;
  score += (n.tags?.length ?? 0) * 3;
  if (n.kind === "transit") score += 10;
  else if (n.kind === "poi") score += 5;
  else if (n.kind === "building") score += 3;
  return score;
}
__name(landmarkScore, "landmarkScore");
function filterLayers(doc, keep) {
  const layerIds = /* @__PURE__ */ new Set();
  for (const [id, layer] of doc.layers) {
    if (keep.has(layer.name)) layerIds.add(id);
  }
  const dropped = /* @__PURE__ */ new Map();
  for (const f of doc.features) {
    if (!layerIds.has(f.layerId)) {
      dropped.set(f.layerId, (dropped.get(f.layerId) ?? 0) + 1);
    }
  }
  const next = {
    ...doc,
    // The layer table is narrowed to what survived, but the dropped layers are
    // retained so their omission records still resolve to a human-readable
    // name at compile time.
    layers: doc.layers,
    classes: new Map([...doc.classes].filter(([, c]) => layerIds.has(c.layerId))),
    features: doc.features.filter((f) => layerIds.has(f.layerId))
  };
  for (const [layerId, count] of dropped) {
    next.omissions.push({ layerId, count });
  }
  if (dropped.size > 0) {
    const total = [...dropped.values()].reduce((a, b) => a + b, 0);
    next.meta.omitted_total = String(total);
  }
  return next;
}
__name(filterLayers, "filterLayers");

// ../../src/diff/diff.ts
function geomKey(f) {
  return JSON.stringify(f.geometry);
}
__name(geomKey, "geomKey");
function resolvedAttrs(f, doc) {
  const out = {};
  const set = doc.attrSets.get(f.attrSet);
  if (!set) return out;
  for (const p of set.props) {
    const key = doc.strings.get(p.key) ?? `key${p.key}`;
    const v = p.value;
    out[key] = v.t === "ref" ? doc.strings.get(v.ref) ?? v.ref : v.t === "num" ? v.num : v.t === "bool" ? v.bool : v.token;
  }
  return out;
}
__name(resolvedAttrs, "resolvedAttrs");
function aspectsOf(a, da, b, db) {
  const out = [];
  if ((da.layers.get(a.layerId)?.name ?? a.layerId) !== (db.layers.get(b.layerId)?.name ?? b.layerId)) {
    out.push("layer");
  }
  if ((da.classes.get(a.classId)?.name ?? a.classId) !== (db.classes.get(b.classId)?.name ?? b.classId)) {
    out.push("class");
  }
  if (a.kind !== b.kind || geomKey(a) !== geomKey(b)) out.push("geometry");
  if (JSON.stringify(resolvedAttrs(a, da)) !== JSON.stringify(resolvedAttrs(b, db))) {
    out.push("attributes");
  }
  return out;
}
__name(aspectsOf, "aspectsOf");
function diffDocuments(a, b) {
  const am = new Map(a.features.map((f) => [f.id, f]));
  const bm = new Map(b.features.map((f) => [f.id, f]));
  const out = [];
  for (const [id, fa] of [...am.entries()].sort((x, y) => x[0] - y[0])) {
    const fb = bm.get(id);
    if (!fb) {
      out.push({ op: "-", id, aspects: [] });
      continue;
    }
    const aspects = aspectsOf(fa, a, fb, b);
    if (aspects.length > 0) out.push({ op: "~", id, aspects });
  }
  for (const [id] of [...bm.entries()].sort((x, y) => x[0] - y[0])) {
    if (!am.has(id)) out.push({ op: "+", id, aspects: [] });
  }
  return out.sort((x, y) => x.id - y.id);
}
__name(diffDocuments, "diffDocuments");
function featureLabel(f, doc) {
  const layer = doc.layers.get(f.layerId)?.name ?? `layer${f.layerId}`;
  const attrs = doc.attrSets.get(f.attrSet);
  let name = "";
  if (attrs) {
    for (const p of attrs.props) {
      if (doc.strings.get(p.key) === "name" && p.value.t === "ref") {
        name = doc.strings.get(p.value.ref) ?? "";
        break;
      }
    }
  }
  return name ? `${name} (${layer})` : `feature ${f.id} (${layer})`;
}
__name(featureLabel, "featureLabel");
function renderDiff(changes, a, b) {
  const byId = /* @__PURE__ */ __name((doc) => new Map(doc.features.map((f) => [f.id, f])), "byId");
  const am = byId(a);
  const bm = byId(b);
  return changes.map((c) => {
    if (c.op === "-") {
      const f2 = am.get(c.id);
      return `- ${c.id} ${f2 ? featureLabel(f2, a) : ""}`.trimEnd();
    }
    const f = bm.get(c.id);
    const label = f ? featureLabel(f, b) : "";
    const suffix = c.op === "~" ? ` (${c.aspects.join(", ")})` : "";
    return `${c.op} ${c.id} ${label}${suffix}`.trimEnd();
  }).join("\n");
}
__name(renderDiff, "renderDiff");

// ../../src/session/session.ts
function moveMaplet(scr, features, opts = {}) {
  const prev = decodeDocument(scr);
  const view = toMaplet(features, {
    ...opts,
    envelope: prev.envelope
  });
  const changes = diffDocuments(prev, view.doc);
  const report = renderDiff(changes, prev, view.doc);
  const counts = {
    added: changes.filter((c) => c.op === "+").length,
    removed: changes.filter((c) => c.op === "-").length,
    updated: changes.filter((c) => c.op === "~").length
  };
  return {
    changes,
    report,
    counts,
    scr: view.scr,
    yaml: view.yaml,
    metrics: {
      yamlTokens: view.metrics.tokens,
      wireBytes: view.metrics.wireBytes,
      wireTokens: view.metrics.wireTokens
    },
    view: {
      center: view.graph.meta.center,
      ...view.graph.meta.note ? { note: view.graph.meta.note } : {}
    }
  };
}
__name(moveMaplet, "moveMaplet");
function sessionDoc(scr) {
  return decodeDocument(scr);
}
__name(sessionDoc, "sessionDoc");
function sessionEnvelopeContains(env, bbox) {
  const latOk = bbox.south >= env.south && bbox.north <= env.north;
  if (!latOk) return false;
  if (env.west <= env.east) {
    return bbox.west >= env.west && bbox.east <= env.east;
  }
  return bbox.west >= env.west && bbox.east <= 180;
}
__name(sessionEnvelopeContains, "sessionEnvelopeContains");

// ../../src/source/types.ts
var plainFetch = /* @__PURE__ */ __name((...args) => fetch(...args), "plainFetch");
function bboxAround(lat, lon, radiusM) {
  const dLat = radiusM / 110574;
  const dLon = radiusM / (111320 * Math.cos(lat * Math.PI / 180));
  return {
    west: lon - dLon,
    south: lat - dLat,
    east: lon + dLon,
    north: lat + dLat
  };
}
__name(bboxAround, "bboxAround");
function normalizeBbox(b) {
  const west = Math.max(-180, Math.min(180, b.west));
  const east = Math.max(-180, Math.min(180, b.east));
  return {
    west: Math.min(west, east),
    south: Math.max(-85.05112878, Math.min(85.05112878, b.south)),
    east: Math.max(west, east),
    north: Math.max(-85.05112878, Math.min(85.05112878, b.north))
  };
}
__name(normalizeBbox, "normalizeBbox");

// ../../src/source/overpass.ts
var DEFAULT_ENDPOINT = "https://overpass-api.de/api/interpreter";
var DEFAULT_TIMEOUT = 6e4;
var DEFAULT_USER_AGENT = "supercarto/0.2.0 (LLM spatial middleware; +https://github.com/supercarto)";
function summarizeError(text) {
  const strong = /<strong[^>]*>Error<\/strong>\s*:?\s*([^<]*)/i.exec(text);
  if (strong?.[1]) return strong[1].replace(/\s+/g, " ").trim().slice(0, 200);
  const paragraphs = [...text.matchAll(/<p>([^<]+)<\/p>/g)].map((m) => m[1].trim());
  const useful = paragraphs.filter(
    (p) => !/openstreetmap\.org|ODbL|available under/i.test(p)
  );
  if (useful.length > 0) return useful[useful.length - 1].replace(/\s+/g, " ").slice(0, 200);
  const stripped = text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return stripped.slice(0, 160) || "no detail";
}
__name(summarizeError, "summarizeError");
var DEFAULT_LAYERS = [
  "highway",
  "building",
  "amenity",
  "railway",
  "shop",
  "tourism",
  "office",
  "leisure",
  "natural",
  "waterway"
];
var HIGHWAY_TAGS = [
  "motorway",
  "trunk",
  "primary",
  "secondary",
  "tertiary",
  "residential",
  "unclassified",
  "living_street",
  "pedestrian",
  "service",
  "motorway_link",
  "trunk_link",
  "primary_link",
  "secondary_link",
  "tertiary_link"
];
var EXCLUDED_HIGHWAYS = "footway|path|steps|cycleway|track|bridleway|corridor";
var LAYER_TAGS = {
  highway: "highway",
  railway: "railway",
  amenity: "amenity",
  shop: "shop",
  tourism: "tourism",
  office: "office",
  leisure: "leisure",
  natural: "natural",
  waterway: "waterway",
  building: "building"
};
var LAYER_ALIASES = {
  road: ["highway"],
  poi: ["amenity", "shop", "tourism"]
};
function normalizeLayers(user) {
  const known = /* @__PURE__ */ new Set([...Object.keys(LAYER_TAGS), ...Object.keys(LAYER_ALIASES)]);
  const unknown = user.filter((l) => !known.has(l));
  if (unknown.length > 0) {
    throw new Error(
      `unknown layer(s) ${unknown.map((u) => `"${u}"`).join(", ")}. Valid: ${[...Object.keys(LAYER_ALIASES), ...Object.keys(LAYER_TAGS)].join(", ")}`
    );
  }
  const order = new Map(DEFAULT_LAYERS.map((l, i) => [l, i]));
  return [...new Set(user.flatMap((l) => LAYER_ALIASES[l] ?? [l]))].sort(
    (a, b) => (order.get(a) ?? 99) - (order.get(b) ?? 99)
  );
}
__name(normalizeLayers, "normalizeLayers");
var OverpassError = class extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
  status;
  static {
    __name(this, "OverpassError");
  }
  name = "OverpassError";
};
function isRetryable(err) {
  if (!(err instanceof OverpassError)) return false;
  return err.status === 429 || err.status === 504 || err.status === 502 || err.status === 503;
}
__name(isRetryable, "isRetryable");
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
__name(sleep, "sleep");
function sampleOutside(features) {
  const parts = [];
  for (const f of features.slice(0, 3)) {
    const c = allCoordinates(f.geometry)[0];
    if (c) parts.push(`lon=${c[0]} lat=${c[1]}`);
  }
  return parts.join(", ");
}
__name(sampleOutside, "sampleOutside");
var EMPTY_RETRY_BUDGET = 2;
var MAX_SHRINK_ATTEMPTS = 4;
function countWays(features) {
  let n = 0;
  for (const f of features) {
    if (f.geometry?.type === "LineString") n++;
  }
  return n;
}
__name(countWays, "countWays");
function tighten(bbox) {
  const { west, south, east, north } = bbox;
  const cx = (west + east) / 2;
  const cy = (south + north) / 2;
  const halfW = (east - west) / 2 * 0.6;
  const halfH = (north - south) / 2 * 0.6;
  if (halfH < 45e-5 || halfW < 6e-4) return void 0;
  return { west: cx - halfW, south: cy - halfH, east: cx + halfW, north: cy + halfH };
}
__name(tighten, "tighten");
function isPopulatedLand(bbox) {
  const midLat = (bbox.south + bbox.north) / 2;
  if (Math.abs(midLat) >= 66) return false;
  if (midLat < -55) return false;
  return true;
}
__name(isPopulatedLand, "isPopulatedLand");
var SERVER_SIDE_CAP = 5e3;
function buildQuery(req) {
  const { south: s, west: w, north: n, east: e } = req.bbox;
  const area = `(${s},${w},${n},${e})`;
  const parts = [];
  for (const layer of req.layers) {
    const tag = LAYER_TAGS[layer] ?? layer;
    if (tag === "highway") {
      parts.push(HIGHWAY_TAGS.map((t) => `    way${area}[highway=${t}];`).join("\n"));
      parts.push(`    node${area}[highway=bus_stop];`);
      continue;
    }
    if (tag === "natural") {
      parts.push(`    way${area}[natural=water];`);
      parts.push(`    way${area}[natural=wood];`);
      parts.push(`    way${area}[natural=scrub];`);
      continue;
    }
    if (tag === "building") {
      parts.push(`    way${area}[building][building!="no"];`);
      continue;
    }
    if (tag === "railway") {
      parts.push(`    node${area}[railway=tram_stop];`);
      parts.push(`    node${area}[railway=subway_entrance];`);
      parts.push(`    node${area}[railway=station];`);
      parts.push(`    node${area}[railway=halt];`);
      continue;
    }
    parts.push(`    node${area}[${tag}];`);
    parts.push(`    way${area}[${tag}][highway!~"^(${EXCLUDED_HIGHWAYS})$"];`);
  }
  const cap = Math.min(req.maxFeatures || SERVER_SIDE_CAP, SERVER_SIDE_CAP);
  return `[out:json][timeout:25];
(
${parts.join("\n")}
);
out geom qt ${cap};`;
}
__name(buildQuery, "buildQuery");
function clipGeometry(f, keep) {
  const g = f.geometry;
  if (!g) return f;
  const inKeep = /* @__PURE__ */ __name((c) => keep.some((k) => k[0] === c[0] && k[1] === c[1]), "inKeep");
  if (g.type === "LineString") {
    return { ...f, geometry: { type: "LineString", coordinates: keep } };
  }
  if (g.type === "MultiLineString") {
    const parts = g.coordinates ?? [];
    const runs = parts.map((line) => line.filter((c) => inKeep(c))).filter((line) => line.length >= 2).sort((a, b) => b.length - a.length);
    if (runs.length === 0) {
      return { ...f, geometry: { type: "LineString", coordinates: [] } };
    }
    return { ...f, geometry: { type: "LineString", coordinates: runs[0] } };
  }
  if (g.type === "Polygon") {
    const rings = g.coordinates ?? [];
    const ring = (rings[0] ?? []).filter((c) => inKeep(c));
    const first = ring[0];
    const last = ring[ring.length - 1];
    const closed = !!first && !!last && first[0] === last[0] && first[1] === last[1];
    return {
      ...f,
      geometry: {
        type: "Polygon",
        // An unclosed ring is no longer the same shape; an empty ring is
        // rejected downstream rather than reported as a real area.
        coordinates: closed && ring.length >= 4 ? [ring] : []
      }
    };
  }
  return f;
}
__name(clipGeometry, "clipGeometry");
function nodeToFeature(el) {
  return {
    type: "Feature",
    id: el.id,
    properties: { ...el.tags ?? {} },
    geometry: { type: "Point", coordinates: [el.lon, el.lat] }
  };
}
__name(nodeToFeature, "nodeToFeature");
function allCoordinates(geom) {
  const g = geom;
  const out = [];
  const walk = /* @__PURE__ */ __name((node) => {
    if (!Array.isArray(node)) return;
    if (node.length >= 2 && typeof node[0] === "number" && typeof node[1] === "number") {
      out.push([node[0], node[1]]);
      return;
    }
    for (const child of node) walk(child);
  }, "walk");
  walk(g.coordinates);
  return out;
}
__name(allCoordinates, "allCoordinates");
function wayToFeature(el, coords) {
  if (coords.length < 2) return void 0;
  const tags = el.tags ?? {};
  const isArea = coords.length >= 3 && isClosed(coords) && isAreaTag(tags);
  return {
    type: "Feature",
    id: el.id,
    properties: { ...tags },
    geometry: isArea ? { type: "Polygon", coordinates: [coords] } : { type: "LineString", coordinates: coords }
  };
}
__name(wayToFeature, "wayToFeature");
function isClosed(coords) {
  const a = coords[0];
  const b = coords[coords.length - 1];
  return a[0] === b[0] && a[1] === b[1];
}
__name(isClosed, "isClosed");
var AREA_KEYS = ["building", "landuse", "natural", "leisure", "amenity", "shop", "tourism", "place", "waterway"];
function isAreaTag(tags) {
  for (const k of AREA_KEYS) {
    const v = tags[k];
    if (v === void 0) continue;
    if (k === "waterway" && v !== "riverbank" && v !== "dock") return false;
    if (k === "highway") return false;
    return true;
  }
  return false;
}
__name(isAreaTag, "isAreaTag");
var OverpassSource = class {
  static {
    __name(this, "OverpassSource");
  }
  name = "osm-overpass";
  description = "OpenStreetMap via the Overpass API. Any coordinates, no API key.";
  endpoint;
  timeoutMs;
  fetchImpl;
  maxFeatures;
  userAgent;
  maxAttempts;
  /** The area currently being fetched, used to reject implausible coordinates. */
  bbox;
  constructor(opts = {}) {
    this.endpoint = opts.endpoint ?? DEFAULT_ENDPOINT;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT;
    this.fetchImpl = opts.fetchImpl ?? plainFetch;
    this.maxFeatures = opts.maxFeatures ?? 5e4;
    this.userAgent = opts.userAgent ?? DEFAULT_USER_AGENT;
    this.maxAttempts = Math.max(1, opts.maxAttempts ?? 4);
  }
  async available() {
    return typeof this.fetchImpl === "function";
  }
  async fetch(req) {
    const started = Date.now();
    const warnings = [];
    const limit = Math.min(req.maxFeatures || this.maxFeatures, this.maxFeatures);
    this.bbox = req.bbox;
    const layers = req.layers.length > 0 ? normalizeLayers(req.layers) : DEFAULT_LAYERS;
    const attempts = this.maxAttempts;
    let box = req.bbox;
    let best;
    let lastError;
    let refusals = 0;
    let sawWays = false;
    const starvedError = /* @__PURE__ */ __name(() => new OverpassError(
      `Overpass served no road geometry after refusing ${refusals} attempt(s); the instance is degraded, not the area empty - retry, shrink the request, or set OVERPASS_ENDPOINT to a self-hosted mirror`,
      502
    ), "starvedError");
    for (let attempt = 0; attempt < attempts; attempt++) {
      const kept = layers.slice(0, Math.max(1, layers.length - attempt));
      const query = buildQuery({ ...req, bbox: box, layers: kept });
      this.bbox = box;
      try {
        const body = await this.request(query, req);
        const raw = body.elements?.length ?? 0;
        const retriedEmpty = attempt < EMPTY_RETRY_BUDGET;
        if (raw === 0 && req.layers.length === 0 && retriedEmpty) {
          warnings.push(
            "Overpass returned an empty result for a populated area; retrying with fewer layers rather than reporting no data"
          );
          continue;
        }
        if (raw === 0 && req.layers.length === 0 && isPopulatedLand(box)) {
          throw new OverpassError(
            `Overpass returned no data for a populated area after ${attempt + 1} attempts; the public instance is degraded - set OVERPASS_ENDPOINT to a self-hosted mirror`,
            502
          );
        }
        const features = this.buildFeatures(body.elements ?? [], limit, warnings);
        const truncated = features.length >= limit;
        const wayElements = (body.elements ?? []).filter((e) => e.type === "way").length;
        if (wayElements > 0) sawWays = true;
        const wantsShrink = req.layers.length === 0 && attempt < MAX_SHRINK_ATTEMPTS && isPopulatedLand(box) && wayElements > 0 && // A truncated result stopped reading before it reached the ways, so
        // the absence of streets says nothing about the upstream response.
        !truncated && countWays(features) === 0;
        if (truncated) {
          warnings.push(`truncated at ${limit} features; area is denser than the cap`);
        }
        if (attempt > 0) {
          warnings.push(
            `Overpass refused the full query ${attempt} time(s); served without layer${kept.length === 1 ? "" : "s"} "${layers.slice(kept.length).join('", "')}"`
          );
        }
        const result = {
          features,
          source: this.name,
          truncated,
          elapsedMs: Date.now() - started,
          warnings: [...warnings]
        };
        if (result.features.length > 0 && (best === void 0 || result.features.length > best.features.length && countWays(result.features) >= countWays(best.features))) {
          best = result;
        }
        const starved = kept.includes("highway") && wayElements === 0 && !truncated && isPopulatedLand(box) && refusals > 0;
        if (starved && attempt < MAX_SHRINK_ATTEMPTS) {
          const tightened = tighten(box);
          if (tightened) {
            box = tightened;
            warnings.push(
              "upstream returned no road geometry after refusing earlier attempts; retrying over a smaller box to stay under the instance result limit"
            );
            continue;
          }
          throw starvedError();
        }
        if (starved) throw starvedError();
        if (wantsShrink) {
          const tightened = tighten(box);
          if (tightened) {
            box = tightened;
            warnings.push(
              "upstream returned no usable street geometry for this area; retrying over a smaller box to stay under the instance result limit"
            );
            continue;
          }
        }
        return result;
      } catch (err) {
        lastError = err;
        if (isRetryable(err)) refusals++;
        if (!isRetryable(err) || attempt === attempts - 1) break;
        await sleep(Math.min(2e3 * (attempt + 1), 6e3));
      }
    }
    if (best) {
      if (layers.includes("highway") && countWays(best.features) === 0 && !sawWays && refusals > 0 && isPopulatedLand(req.bbox)) {
        throw starvedError();
      }
      best.warnings.push("later attempts failed; serving the best result obtained");
      return best;
    }
    if (lastError !== void 0) throw lastError;
    throw new OverpassError(`no attempt was made for this request`, 502);
  }
  /** One HTTP round trip, with the headers and error handling Overpass needs. */
  async request(query, req) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const onAbort = /* @__PURE__ */ __name(() => controller.abort(), "onAbort");
    req.signal?.addEventListener("abort", onAbort);
    try {
      const res = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          // Required. The public instance sits behind Apache, which answers 406
          // to any request without a User-Agent - a failure that looks like a
          // bad query but is not one. A descriptive agent string is also the
          // polite thing to send to a shared public service.
          "User-Agent": this.userAgent,
          Accept: "*/*"
        },
        body: new URLSearchParams({ data: query }).toString(),
        signal: controller.signal
      });
      const bodyText = await res.text();
      if (!res.ok) {
        const detail = summarizeError(bodyText);
        throw new OverpassError(
          `Overpass responded ${res.status} ${res.statusText}: ${detail}`,
          res.status
        );
      }
      try {
        return JSON.parse(bodyText);
      } catch {
        throw new OverpassError(`Overpass returned non-JSON: ${summarizeError(bodyText)}`, 502);
      }
    } catch (err) {
      if (controller.signal.aborted && !req.signal?.aborted) {
        throw new OverpassError(`Overpass request timed out after ${this.timeoutMs}ms`, 504);
      }
      throw err;
    } finally {
      clearTimeout(timer);
      req.signal?.removeEventListener("abort", onAbort);
    }
  }
  /** Assemble GeoJSON from the mixed element list. */
  buildFeatures(elements, limit, warnings) {
    const coordsById = /* @__PURE__ */ new Map();
    const features = [];
    for (const el of elements) {
      if (el.type === "node" && typeof el.lat === "number" && typeof el.lon === "number") {
        coordsById.set(el.id, [el.lon, el.lat]);
      }
    }
    for (const el of elements) {
      if (features.length >= limit) break;
      if (el.type === "node" && typeof el.lat === "number" && typeof el.lon === "number") {
        if (el.tags && Object.keys(el.tags).length > 0) {
          features.push(nodeToFeature(el));
        }
        continue;
      }
      if (el.type === "way") {
        const inline = Array.isArray(el.geometry) ? el.geometry.filter((g) => typeof g?.lat === "number" && typeof g?.lon === "number").map((g) => [g.lon, g.lat]) : [];
        const resolved = Array.isArray(el.nodes) ? el.nodes.map((nid) => coordsById.get(nid)).filter((c) => !!c) : [];
        const coords = inline.length > 0 ? inline : resolved;
        const f = wayToFeature(el, coords);
        if (f) features.push(f);
        continue;
      }
      if (el.type === "relation") {
        const outer = (el.tags ?? {}).natural === "water" || (el.tags ?? {}).landuse === "reservoir";
        if (outer) {
          warnings.push(`relation ${el.id} (${el.tags?.natural ?? el.tags?.landuse}) not resolved`);
        }
      }
    }
    return this.dropImplausible(features, warnings);
  }
  /**
   * Discard features whose coordinates do not match the requested area.
   *
   * This is a real failure mode, not a hypothetical: the public Overpass
   * instance has been observed returning transposed latitudes for whole
   * regions, and `out body` reports them with no indication that anything is
   * wrong. Passed through unchecked, those coordinates land thousands of
   * kilometres away, and the compiler then reports a 26km edge between two
   * cafes that are 8m apart.
   *
   * A tolerance is used rather than a strict bound, because the server may
   * legitimately return features just outside a bbox when one touches a way
   * spanning the boundary. Anything wildly outside is data corruption.
   */
  dropImplausible(features, warnings) {
    if (this.bbox === void 0) return features;
    const { west, south, east, north } = this.bbox;
    const slackLat = Math.max(15e-4, Math.min((north - south) * 0.25, 0.05));
    const slackLon = Math.max(15e-4, Math.min((east - west) * 0.25, 0.05));
    const inside = /* @__PURE__ */ __name(([lon, lat]) => lat >= south - slackLat && lat <= north + slackLat && lon >= west - slackLon && lon <= east + slackLon, "inside");
    const ok = [];
    for (const f of features) {
      if (!f.geometry) continue;
      const coords = allCoordinates(f.geometry);
      if (coords.length === 0) continue;
      if (f.geometry.type === "Point") {
        if (inside(coords[0])) ok.push(f);
        continue;
      }
      const good = coords.filter(inside);
      if (good.length * 2 <= coords.length) continue;
      ok.push(clipGeometry(f, good));
    }
    const dropped = features.length - ok.length;
    if (dropped > 0) {
      warnings.push(
        `discarded ${dropped} feature(s) with coordinates outside the requested area; the upstream data was inconsistent with the query`
      );
    }
    if (features.length > 0 && ok.length === 0) {
      throw new OverpassError(
        `every feature was outside the requested area; upstream coordinates are corrupt (sample: ${sampleOutside(features)})`,
        502
      );
    }
    return ok;
  }
};

// ../../src/source/routing.ts
var DEFAULT_BEARINGS = [
  "north",
  "northeast",
  "east",
  "southeast",
  "south",
  "southwest",
  "west",
  "northwest"
];
var FeasibilityRouter = class {
  static {
    __name(this, "FeasibilityRouter");
  }
  name = "feasibility";
  async route(req) {
    return straightLineRoute(req.from, req.to, req.mode);
  }
};
function straightLineRoute(from, to, mode = "walk") {
  const R = 63710088e-1;
  const dLat = (to.lat - from.lat) * Math.PI / 180;
  const dLon = (to.lon - from.lon) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(from.lat * Math.PI / 180) * Math.cos(to.lat * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  const distance = Math.round(2 * R * Math.asin(Math.min(1, Math.sqrt(a))));
  const speed = mode === "walk" ? 1.35 : mode === "bike" ? 4.5 : 11;
  const duration = Math.round(distance / speed);
  const toRad = Math.PI / 180;
  const phi1 = from.lat * toRad;
  const phi2 = to.lat * toRad;
  const lambda1 = from.lon * toRad;
  const lambda2 = to.lon * toRad;
  const y = Math.sin(lambda2 - lambda1) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(lambda2 - lambda1);
  const bearingDeg = (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  const dir = DEFAULT_BEARINGS[Math.round(bearingDeg / 45) % 8];
  return {
    route: {
      id: 1,
      mode: `${mode}-approx`,
      dist: distance,
      time: duration,
      steps: [
        {
          n: 1,
          instruction: `head ${dir} toward the destination (approx ${distance}m, no routing engine configured) then verify the approach on arrival`,
          dist: distance
        }
      ]
    },
    geometry: [
      [from.lon, from.lat],
      [to.lon, to.lat]
    ],
    source: "straight-line"
  };
}
__name(straightLineRoute, "straightLineRoute");

// ../../src/source/zlibsafe.ts
function nodeRuntime() {
  return globalThis.process !== void 0;
}
__name(nodeRuntime, "nodeRuntime");
var nodeZlibPromise;
async function nodeZlib() {
  if (!nodeRuntime()) return void 0;
  nodeZlibPromise ??= import(zlibSpecs[0]);
  return await nodeZlibPromise;
}
__name(nodeZlib, "nodeZlib");
var zlibSpecs = ["node:zlib"];
async function inflate(buf) {
  const zlib = await nodeZlib();
  if (zlib) return zlib.inflateSync(buf);
  return await webDecompress(buf, "deflate");
}
__name(inflate, "inflate");
async function webDecompress(buf, format) {
  const source = new Response(new Uint8Array(buf)).body;
  if (!source) throw new Error("could not open a decompression stream");
  const deflate = source.pipeThrough(new DecompressionStream(format));
  return new Uint8Array(await new Response(deflate).arrayBuffer());
}
__name(webDecompress, "webDecompress");
async function decompress(buf, compression, what) {
  if (compression === 0 || compression === 1) return buf;
  const zlib = await nodeZlib();
  switch (compression) {
    case 2: {
      if (zlib) return zlib.gunzipSync(buf);
      return await webDecompress(buf, "gzip");
    }
    case 3: {
      if (zlib?.brotliDecompressSync) return zlib.brotliDecompressSync(buf);
      throw new Error(
        `PMTiles ${what} uses brotli, which needs Node's zlib (this runtime has no brotli decoder)`
      );
    }
    case 4: {
      if (zlib?.zstdDecompressSync) return zlib.zstdDecompressSync(buf);
      throw new Error(`PMTiles ${what} uses zstd, which needs Node 22.15 or later`);
    }
    default:
      throw new Error(`unknown PMTiles compression ${compression}`);
  }
}
__name(decompress, "decompress");

// ../../src/source/png.ts
var PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
async function decodePngTerrarium(buf) {
  const parsed = parsePng(buf);
  if (!parsed) return void 0;
  const { header, idat } = parsed;
  let raw;
  try {
    raw = await inflate(concat(idat));
  } catch {
    return void 0;
  }
  const pixels = defilter(raw, header);
  if (!pixels) return void 0;
  const [ir, ig, ib] = header.channels;
  const data = new Float32Array(header.width * header.height);
  for (let p = 0; p < data.length; p++) {
    const o = p * header.stride;
    data[p] = (pixels[o + ir] ?? 0) * 256 + (pixels[o + ig] ?? 0) + (pixels[o + ib] ?? 0) / 256 - 32768;
  }
  return { width: header.width, height: header.height, data };
}
__name(decodePngTerrarium, "decodePngTerrarium");
function parsePng(buf) {
  if (buf.length < 8) return void 0;
  for (let i = 0; i < 8; i++) {
    if (buf[i] !== PNG_SIGNATURE[i]) return void 0;
  }
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let off = 8;
  let header;
  const idat = [];
  while (off + 8 <= buf.length) {
    const len = dv.getUint32(off, false);
    if (len > 2147483647 || off + 12 + len > buf.length) return void 0;
    const type = ascii(buf, off + 4);
    const body = off + 8;
    if (type === "IHDR") {
      if (len !== 13) return void 0;
      header = readHeader(buf, body, dv);
      if (!header) return void 0;
    } else if (type === "IDAT") {
      idat.push(buf.slice(body, body + len));
    } else if (type === "IEND") {
      break;
    }
    off += 12 + len;
  }
  if (!header || idat.length === 0) return void 0;
  return { header, idat };
}
__name(parsePng, "parsePng");
function readHeader(buf, at, dv) {
  const width = dv.getUint32(at, false);
  const height = dv.getUint32(at + 4, false);
  const depth = buf[at + 8];
  const color = buf[at + 9];
  const compression = buf[at + 10];
  const filter = buf[at + 11];
  const interlace = buf[at + 12];
  if (width === 0 || width > 65536 || height === 0 || height > 65536) return void 0;
  if (compression !== 0 || filter !== 0 || interlace !== 0) return void 0;
  if (depth !== 8) return void 0;
  if (color !== 2 && color !== 6) return void 0;
  const stride = color === 2 ? 3 : 4;
  return { width, height, stride, channels: [0, 1, 2] };
}
__name(readHeader, "readHeader");
function defilter(raw, header) {
  const { width, height, stride } = header;
  const rowlen = width * stride;
  if (raw.length < height * (rowlen + 1)) return void 0;
  const out = new Uint8Array(height * rowlen);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (rowlen + 1)];
    const src = y * (rowlen + 1) + 1;
    const dst = y * rowlen;
    for (let i = 0; i < rowlen; i++) {
      const x = src + i;
      const cur = raw[x] ?? 0;
      const left = i >= stride ? out[dst + i - stride] ?? 0 : 0;
      const up = y > 0 ? out[dst - rowlen + i] ?? 0 : 0;
      const upleft = y > 0 && i >= stride ? out[dst - rowlen + i - stride] ?? 0 : 0;
      switch (filter) {
        case 0:
          out[dst + i] = cur;
          break;
        case 1:
          out[dst + i] = cur + left & 255;
          break;
        case 2:
          out[dst + i] = cur + up & 255;
          break;
        case 3:
          out[dst + i] = cur + (left + up >> 1) & 255;
          break;
        case 4:
          out[dst + i] = cur + paeth(left, up, upleft) & 255;
          break;
        default:
          return void 0;
      }
    }
  }
  return out;
}
__name(defilter, "defilter");
function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}
__name(paeth, "paeth");
function concat(parts) {
  if (parts.length === 1) return parts[0];
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const part of parts) {
    out.set(part, off);
    off += part.length;
  }
  return out;
}
__name(concat, "concat");
function ascii(buf, at) {
  return String.fromCharCode(buf[at] ?? 0, buf[at + 1] ?? 0, buf[at + 2] ?? 0, buf[at + 3] ?? 0);
}
__name(ascii, "ascii");

// ../../src/source/terrain.ts
var TerrariumElevation = class {
  static {
    __name(this, "TerrariumElevation");
  }
  name = "terrarium";
  /**
   * URL template with `{z}/{x}/{y}` and `{r}` placeholders.
   * `{r}` is the tile size in pixels, e.g. `256`.
   */
  template;
  fetchImpl;
  maxTiles;
  constructor(opts = {}) {
    this.template = opts.template ?? "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png";
    this.fetchImpl = opts.fetchImpl ?? plainFetch;
    this.maxTiles = opts.maxTiles ?? 16;
  }
  async fetch(bbox, res, signal) {
    const { z, tiles } = tilesFor(bbox, this.maxTiles);
    const size = 256;
    const out = new Float32Array(res * res);
    let min = Infinity;
    let max = -Infinity;
    for (const t of tiles) {
      const res0 = await this.fetchImpl(
        this.template.replace("{z}", String(z)).replace("{x}", String(t.x)).replace("{y}", String(t.y)).replace("{r}", String(size)),
        { signal }
      );
      if (!res0.ok) continue;
      const buf = new Uint8Array(await res0.arrayBuffer());
      const pixels = pngSignature(buf) ? await decodePngTerrarium(buf) : decodeRawTerrarium(buf);
      if (!pixels) continue;
      for (let i = 0; i < out.length; i++) {
        const v = sampleBilinear(pixels, pixels.width, pixels.height, i % res, Math.floor(i / res), res);
        out[i] = v;
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }
    if (min === Infinity) {
      min = 0;
      max = 0;
    }
    return { bbox, width: res, height: res, values: out, min, max };
  }
};
function pngSignature(buf) {
  return buf.length >= 8 && buf[0] === 137 && buf[1] === 80 && buf[2] === 78 && buf[3] === 71 && buf[4] === 13 && buf[5] === 10 && buf[6] === 26 && buf[7] === 10;
}
__name(pngSignature, "pngSignature");
function decodeRawTerrarium(buf) {
  if (buf.length < 8) return void 0;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const width = dv.getUint32(0, true);
  const height = dv.getUint32(4, true);
  const expected = width * height * 2;
  if (buf.length < 8 + expected) return void 0;
  const data = new Float32Array(width * height);
  for (let i = 0; i < data.length; i++) {
    data[i] = (dv.getInt16(8 + i * 2, false) - 32768) / 256;
  }
  return { width, height, data };
}
__name(decodeRawTerrarium, "decodeRawTerrarium");
function sampleBilinear(grid, gw, gh, x, y, res) {
  const fx = x / Math.max(1, res - 1) * (gw - 1);
  const fy = y / Math.max(1, res - 1) * (gh - 1);
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(gw - 1, x0 + 1);
  const y1 = Math.min(gh - 1, y0 + 1);
  const tx = fx - x0;
  const ty = fy - y0;
  const a = elev(grid.data, gw, gh, x0, y0);
  const b = elev(grid.data, gw, gh, x1, y0);
  const c = elev(grid.data, gw, gh, x0, y1);
  const d = elev(grid.data, gw, gh, x1, y1);
  const top = a + (b - a) * tx;
  const bot = c + (d - c) * tx;
  return top + (bot - top) * ty;
}
__name(sampleBilinear, "sampleBilinear");
function elev(data, w, h, x, y) {
  const cx = Math.max(0, Math.min(w - 1, x));
  const cy = Math.max(0, Math.min(h - 1, y));
  return data[cy * w + cx] ?? 0;
}
__name(elev, "elev");
function tilesFor(bbox, maxTiles) {
  const nw = tileX(bbox.west, bbox.north);
  const se = tileX(bbox.east, bbox.south);
  for (let z = 12; z >= 0; z--) {
    const a = nw(z);
    const b = se(z);
    const w = Math.abs(b.x - a.x) + 1;
    const h = Math.abs(b.y - a.y) + 1;
    if (w * h <= maxTiles) {
      const tiles = [];
      for (let x = a.x; x <= b.x; x++) {
        for (let y = a.y; y <= b.y; y++) tiles.push({ x, y });
      }
      return { z, tiles };
    }
  }
  return { z: 0, tiles: [{ x: 0, y: 0 }] };
}
__name(tilesFor, "tilesFor");
function tileX(lon, lat) {
  return (z) => {
    const n = 2 ** z;
    const x = Math.floor((lon + 180) / 360 * n);
    const latRad = Math.max(-85.05112878, Math.min(85.05112878, lat)) * (Math.PI / 180);
    const y = Math.floor((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n);
    return { x: Math.max(0, Math.min(n - 1, x)), y: Math.max(0, Math.min(n - 1, y)) };
  };
}
__name(tileX, "tileX");

// ../../src/source/heat.ts
function densityToHeat(points, envelope, opts = {}) {
  if (points.length === 0) return void 0;
  const extent = maxOf(points.map((p) => p.x), maxOf(points.map((p) => p.y), 1));
  const res = opts.resolution ?? 16;
  const maxCells = opts.maxCells ?? 24;
  const bins = /* @__PURE__ */ new Map();
  for (const p of points) {
    const cx = Math.min(res - 1, Math.max(0, Math.floor(p.x / extent * res)));
    const cy = Math.min(res - 1, Math.max(0, Math.floor(p.y / extent * res)));
    const key = cy * res + cx;
    bins.set(key, (bins.get(key) ?? 0) + p.value);
  }
  const ranked = [...bins.entries()].sort((a, b) => b[1] - a[1]).slice(0, maxCells);
  if (ranked.length === 0) return void 0;
  const values = ranked.map(([, v]) => v);
  const cells = ranked.map(([key, v]) => ({
    x: key % res,
    y: Math.floor(key / res),
    value: v
  }));
  void envelope;
  void opts.metresPerUnit;
  return {
    id: 1,
    name: opts.name ?? "poi_density",
    resolution: res,
    minValue: Math.min(...values),
    maxValue: Math.max(...values),
    encoding: "sparse",
    cells
  };
}
__name(densityToHeat, "densityToHeat");
function slopeToHeat(elevations, width, height, opts = {}) {
  if (width < 2 || height < 2) return void 0;
  const mpu = opts.metresPerUnit ?? 1;
  const res = 16;
  const bins = /* @__PURE__ */ new Map();
  const grade = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const here = elevations[y * width + x] ?? 0;
      const right = elevations[y * width + Math.min(width - 1, x + 1)] ?? here;
      const down = elevations[Math.min(height - 1, y + 1) * width + x] ?? here;
      const run = mpu;
      grade[y * width + x] = Math.hypot(right - here, down - here) / run;
      bins.set(cellKey(x, y, width, height, res), grade[y * width + x]);
    }
  }
  const all = [...bins.values()];
  if (all.length === 0) return void 0;
  const rawMax = Math.max(...all);
  const rawMin = Math.min(...all);
  if (rawMax - rawMin <= 0) return void 0;
  const ranked = [...bins.entries()].sort((a, b) => b[1] - a[1]).slice(0, opts.maxCells ?? 16);
  if (ranked.length === 0) return void 0;
  const MAX_GRADE_PCT = 20;
  const values = ranked.map(([, v]) => Math.min(MAX_GRADE_PCT, v * 100));
  return {
    id: 1,
    name: opts.name ?? "slope_pct",
    resolution: res,
    // The declared range is the layer's own range, over every cell and clamped at
    // the same ceiling the emitted values use. Taking it from the emitted top-N
    // instead reported max == min whenever those happened to tie, which collapsed
    // the compiler's `rel` normalisation to a divide-by-nothing.
    minValue: Math.round(Math.min(MAX_GRADE_PCT, rawMin * 100)),
    maxValue: Math.round(Math.min(MAX_GRADE_PCT, rawMax * 100)),
    encoding: "sparse",
    cells: ranked.map(([key], i) => ({
      x: key % res,
      y: Math.floor(key / res),
      value: Math.round(values[i])
    }))
  };
}
__name(slopeToHeat, "slopeToHeat");
function cellKey(x, y, w, h, res) {
  const cx = Math.min(res - 1, Math.max(0, Math.floor(x / Math.max(1, w - 1) * res)));
  const cy = Math.min(res - 1, Math.max(0, Math.floor(y / Math.max(1, h - 1) * res)));
  return cy * res + cx;
}
__name(cellKey, "cellKey");
function maxOf(xs, fallback) {
  let m = fallback;
  for (const x of xs) if (x > m) m = x;
  return m;
}
__name(maxOf, "maxOf");

// ../../src/source/weather.ts
var OPEN_METEO_DEFAULT = "https://api.open-meteo.com/v1/forecast";
var CURRENT_FIELDS = [
  "temperature_2m",
  "apparent_temperature",
  "precipitation",
  "rain",
  "showers",
  "snowfall",
  "weather_code",
  "cloud_cover",
  "wind_speed_10m",
  "wind_direction_10m",
  "wind_gusts_10m",
  "visibility",
  "relative_humidity_2m",
  "is_day"
];
var HOURLY_FIELDS = [
  "temperature_2m",
  "precipitation",
  "rain",
  "showers",
  "snowfall",
  "weather_code",
  "wind_speed_10m"
];
var DAILY_FIELDS = [
  "weather_code",
  "temperature_2m_max",
  "temperature_2m_min",
  "precipitation_sum",
  "precipitation_probability_max",
  "wind_speed_10m_max"
];
var OpenMeteoWeather = class {
  static {
    __name(this, "OpenMeteoWeather");
  }
  name = "open-meteo";
  endpoint;
  fetchImpl;
  timeoutMs;
  constructor(opts = {}) {
    this.endpoint = opts.endpoint ?? OPEN_METEO_DEFAULT;
    this.fetchImpl = opts.fetchImpl ?? plainFetch;
    this.timeoutMs = opts.timeoutMs ?? 12e3;
  }
  async fetch(lat, lon, forecastHours = 12, signal) {
    const days = Math.max(1, Math.min(7, Math.ceil(forecastHours / 24) + 1));
    const params = new URLSearchParams({
      latitude: lat.toFixed(5),
      longitude: lon.toFixed(5),
      current: CURRENT_FIELDS.join(","),
      hourly: HOURLY_FIELDS.join(","),
      daily: DAILY_FIELDS.join(","),
      forecast_days: String(days),
      timezone: "UTC",
      wind_speed_unit: "kmh"
    });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const onAbort = /* @__PURE__ */ __name(() => controller.abort(), "onAbort");
    signal?.addEventListener("abort", onAbort);
    let degraded;
    try {
      const res = await this.fetchImpl(`${this.endpoint}?${params.toString()}`, {
        signal: controller.signal
      });
      if (!res.ok) {
        throw new Error(`weather source responded ${res.status} ${res.statusText}`);
      }
      const body = await res.json();
      if (body.error) throw new Error(`weather source error: ${body.reason ?? "unknown"}`);
      const now = readNow(body);
      return {
        now,
        hourly: readHourly(body, forecastHours),
        daily: readDaily(body),
        lat: typeof body.latitude === "number" ? body.latitude : lat,
        lon: typeof body.longitude === "number" ? body.longitude : lon,
        gridOffsetM: gridOffset(lat, lon, body.latitude, body.longitude),
        source: this.name,
        ...degraded ? { degraded } : {}
      };
    } catch (err) {
      degraded = err instanceof Error ? err.message : String(err);
      return {
        now: unknownConditions(),
        hourly: [],
        daily: [],
        lat,
        lon,
        gridOffsetM: 0,
        source: this.name,
        degraded
      };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }
};
function cell(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : Number.NaN;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : Number.NaN;
  }
  return Number.NaN;
}
__name(cell, "cell");
function cellOrZero(v) {
  const n = cell(v);
  return Number.isNaN(n) ? 0 : n;
}
__name(cellOrZero, "cellOrZero");
function readNow(body) {
  const c = body.current ?? {};
  const num3 = /* @__PURE__ */ __name((k) => cell(c[k]), "num");
  const code = cellOrZero(c.weather_code);
  const isDay = cellOrZero(c.is_day) === 1;
  const rain = cellOrZero(c.rain) + cellOrZero(c.showers);
  const snow = cellOrZero(c.snowfall);
  const visibility = cell(c.visibility);
  return {
    tempC: num3("temperature_2m"),
    feelsLikeC: num3("apparent_temperature"),
    precipitationMm: num3("precipitation"),
    precipitation: classifyPrecipitation(rain, snow, code),
    code,
    summary: describeCode(code, isDay),
    cloudCoverPct: num3("cloud_cover"),
    windKmh: num3("wind_speed_10m"),
    windDirDeg: num3("wind_direction_10m"),
    gustKmh: num3("wind_gusts_10m"),
    // Visibility is absent in some regions; 10km is the standard "unlimited"
    // figure, but it is only used when the source actually omits the field, not
    // when it reports 0.
    visibilityM: Number.isNaN(visibility) ? 1e4 : visibility,
    humidityPct: num3("relative_humidity_2m"),
    at: typeof c.time === "string" ? `${c.time}:00Z` : void 0,
    night: !isDay
  };
}
__name(readNow, "readNow");
function readHourly(body, hours) {
  const h = body.hourly;
  if (!h) return [];
  const times = h.time;
  if (!Array.isArray(times)) return [];
  const start = findNowIndex(times, body.current?.time);
  const out = [];
  for (let i = start; i < times.length && out.length < hours; i++) {
    const at = times[i];
    if (typeof at !== "string") continue;
    const rain = cellOrZero(h.rain?.[i]) + cellOrZero(h.showers?.[i]);
    const snow = cellOrZero(h.snowfall?.[i]);
    out.push({
      at: `${at}:00Z`,
      tempC: cell(h.temperature_2m?.[i]),
      precipitationMm: cell(h.precipitation?.[i]),
      precipitation: classifyPrecipitation(rain, snow, cellOrZero(h.weather_code?.[i])),
      windKmh: cell(h.wind_speed_10m?.[i]),
      code: cellOrZero(h.weather_code?.[i])
    });
  }
  return out;
}
__name(readHourly, "readHourly");
function findNowIndex(times, currentTime) {
  if (typeof currentTime !== "string") return 0;
  const hour = currentTime.slice(0, 13);
  const idx = times.findIndex((t) => typeof t === "string" && t.slice(0, 13) === hour);
  return idx >= 0 ? idx : 0;
}
__name(findNowIndex, "findNowIndex");
function readDaily(body) {
  const d = body.daily;
  if (!d) return [];
  const dates = d.time;
  if (!Array.isArray(dates)) return [];
  return dates.map((date, i) => ({
    date: String(date),
    tempMaxC: cell(d.temperature_2m_max?.[i]),
    tempMinC: cell(d.temperature_2m_min?.[i]),
    precipitationMm: cell(d.precipitation_sum?.[i]),
    precipitationProbPct: cell(d.precipitation_probability_max?.[i]),
    windKmh: cell(d.wind_speed_10m_max?.[i]),
    code: cellOrZero(d.weather_code?.[i])
  }));
}
__name(readDaily, "readDaily");
function classifyPrecipitation(rain, snow, code) {
  if (snow > 0 && rain > 0) return "sleet";
  if (snow > 0) return "snow";
  if (code >= 95) return "hail";
  if (code === 85 || code === 86) return "snow";
  if (rain > 0) return code >= 51 && code <= 57 ? "drizzle" : "rain";
  return "none";
}
__name(classifyPrecipitation, "classifyPrecipitation");
function describeCode(code, isDay = true) {
  switch (code) {
    case 0:
      return isDay ? "clear" : "clear night";
    case 1:
      return isDay ? "mainly clear" : "mainly clear night";
    case 2:
      return "partly cloudy";
    case 3:
      return "overcast";
    case 45:
    case 48:
      return "fog";
    case 51:
    case 53:
      return "light drizzle";
    case 55:
      return "drizzle";
    case 56:
    case 57:
      return "freezing drizzle";
    case 61:
      return "light rain";
    case 63:
      return "rain";
    case 65:
      return "heavy rain";
    case 66:
    case 67:
      return "freezing rain";
    case 71:
      return "light snow";
    case 73:
      return "snow";
    case 75:
      return "heavy snow";
    case 77:
      return "snow grains";
    case 80:
      return "light showers";
    case 81:
      return "showers";
    case 82:
      return "violent showers";
    case 85:
    case 86:
      return "snow showers";
    case 95:
      return "thunderstorm";
    case 96:
    case 99:
      return "thunderstorm with hail";
    default:
      return "unknown";
  }
}
__name(describeCode, "describeCode");
function unknownConditions() {
  return {
    tempC: Number.NaN,
    feelsLikeC: Number.NaN,
    precipitationMm: Number.NaN,
    precipitation: "none",
    code: -1,
    summary: "unknown - weather source unavailable",
    cloudCoverPct: Number.NaN,
    windKmh: Number.NaN,
    windDirDeg: Number.NaN,
    gustKmh: Number.NaN,
    visibilityM: Number.NaN,
    humidityPct: Number.NaN,
    night: false
  };
}
__name(unknownConditions, "unknownConditions");
function gridOffset(lat, lon, glat, glon) {
  if (typeof glat !== "number" || typeof glon !== "number") return 0;
  const R = 63710088e-1;
  const toRad = Math.PI / 180;
  const dLat = (glat - lat) * toRad;
  const dLon = (glon - lon) * toRad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat * toRad) * Math.cos(glat * toRad) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.min(1, Math.sqrt(a))));
}
__name(gridOffset, "gridOffset");

// ../../src/source/traffic.ts
function processEnv() {
  return globalThis.process?.env;
}
__name(processEnv, "processEnv");
var TomTomFlow = class {
  static {
    __name(this, "TomTomFlow");
  }
  name = "tomtom";
  key;
  base;
  fetchImpl;
  timeoutMs;
  constructor(opts = {}) {
    this.key = opts.apiKey ?? processEnv()?.TOMTOM_API_KEY ?? processEnv()?.TRAFFIC_API_KEY;
    this.base = opts.base ?? "https://api.tomtom.com";
    this.fetchImpl = opts.fetchImpl ?? plainFetch;
    this.timeoutMs = opts.timeoutMs ?? 1e4;
  }
  configured() {
    return typeof this.key === "string" && this.key !== "";
  }
  async flow(req, freeFlow) {
    if (!this.configured()) return void 0;
    const points = waypoints(freeFlow.geometry, req).join(";");
    if (points.length < 3) return void 0;
    const url = `${this.base}/traffic/services/flowinformation?key=${encodeURIComponent(this.key)}&points=${points}&unit=kmh&language=en&departureTime=now`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(url, { signal: controller.signal });
      if (!res.ok) return void 0;
      const body = await res.json();
      const segments = [];
      for (const road of body.flows ?? []) {
        for (const f of road.flows ?? []) {
          const speed = typeof f.currentSpeed === "number" ? f.currentSpeed : void 0;
          const free = typeof f.freeFlowSpeed === "number" ? f.freeFlowSpeed : void 0;
          const ratio = speed !== void 0 && free !== void 0 && free > 0 ? Math.min(1, speed / free) : void 0;
          const roadName = typeof f.roadName === "string" ? f.roadName : void 0;
          const segment = {
            ...roadName ? { road: roadName } : {},
            level: ratio === void 0 ? "unknown" : levelForRatio(ratio),
            ...speed !== void 0 ? { speedKmh: speed } : {},
            ...free !== void 0 ? { freeFlowKmh: free } : {},
            ...ratio !== void 0 ? { ratio: Math.round(ratio * 100) / 100 } : {},
            ...f.confidence === "low" ? { stale: true } : {}
          };
          segments.push(segment);
        }
      }
      if (segments.length === 0) return void 0;
      return { segments, source: this.name };
    } catch {
      return void 0;
    } finally {
      clearTimeout(timer);
    }
  }
};
var HereFlow = class {
  static {
    __name(this, "HereFlow");
  }
  name = "here";
  key;
  base;
  fetchImpl;
  timeoutMs;
  constructor(opts = {}) {
    this.key = opts.apiKey ?? processEnv()?.HERE_API_KEY;
    this.base = opts.base ?? "https://traffic.ls.hereapi.com";
    this.fetchImpl = opts.fetchImpl ?? plainFetch;
    this.timeoutMs = opts.timeoutMs ?? 1e4;
  }
  configured() {
    return typeof this.key === "string" && this.key !== "";
  }
  async flow(req, freeFlow) {
    if (!this.configured()) return void 0;
    const points = waypoints(freeFlow.geometry, req);
    if (points.length < 2) return void 0;
    const path = points.map((p) => {
      const parts = p.split(",");
      return `${parts[1]};${parts[0]}`;
    }).join("|");
    const url = `${this.base}/traffic/v2/flow?apiKey=${encodeURIComponent(this.key)}&points=${path}&return=summary,polyline`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(url, { signal: controller.signal });
      if (!res.ok) return void 0;
      const body = await res.json();
      const segments = [];
      for (const f of body.currentFlow ?? []) {
        const loc = f.location ?? {};
        const ratio = typeof loc.currentSpeed === "number" && typeof loc.freeFlowSpeed === "number" && loc.freeFlowSpeed > 0 ? Math.min(1, loc.currentSpeed / loc.freeFlowSpeed) : void 0;
        if (ratio === void 0) continue;
        segments.push({
          ...loc.roadName ? { road: loc.roadName } : {},
          level: levelForRatio(ratio),
          speedKmh: loc.currentSpeed,
          freeFlowKmh: loc.freeFlowSpeed,
          ratio: Math.round(ratio * 100) / 100,
          ...f.confidence === "low" ? { stale: true } : {}
        });
      }
      if (segments.length === 0) return void 0;
      return { segments, source: this.name };
    } catch {
      return void 0;
    } finally {
      clearTimeout(timer);
    }
  }
};
function levelForRatio(ratio) {
  if (ratio >= 0.9) return "free";
  if (ratio >= 0.75) return "light";
  if (ratio >= 0.6) return "moderate";
  if (ratio >= 0.4) return "heavy";
  return "severe";
}
__name(levelForRatio, "levelForRatio");
var TrafficRouter = class {
  static {
    __name(this, "TrafficRouter");
  }
  router;
  flows;
  constructor(router, flows = []) {
    this.router = router;
    this.flows = flows;
  }
  /** Whether any flow provider has a credential. Gates advertising the tool. */
  get hasFlow() {
    return this.flows.some((f) => f.configured());
  }
  async route(req) {
    const mode = req.mode ?? "drive";
    const routed = await this.router.route({ ...req, mode });
    const freeFlow = routeSummary(routed);
    for (const provider of this.flows) {
      if (!provider.configured()) continue;
      let got;
      try {
        got = await provider.flow(req, freeFlow);
      } catch {
        continue;
      }
      if (!got || got.segments.length === 0) continue;
      const ratios = got.segments.map((s) => s.ratio).filter((r) => typeof r === "number");
      const worstLevel = got.segments.reduce(
        (worst, s) => severity(s.level) > severity(worst) ? s.level : worst,
        "free"
      );
      const mean = ratios.length > 0 ? ratios.reduce((a, b) => a + b, 0) / ratios.length : 1;
      const overall = ratios.length > 0 ? levelForRatio(mean) : "unknown";
      const statedDelay = got.segments.reduce((a, s) => a + (s.delayS ?? 0), 0);
      const delayS = statedDelay > 0 ? statedDelay : Math.round(freeFlow.durationS * (1 / Math.max(0.2, mean) - 1));
      return {
        level: overall,
        worstLevel,
        durationS: freeFlow.durationS + delayS,
        freeFlowS: freeFlow.durationS,
        delayS,
        segments: got.segments,
        source: got.source,
        freeFlowOnly: false
      };
    }
    return {
      level: "unknown",
      worstLevel: "unknown",
      durationS: freeFlow.durationS,
      freeFlowS: freeFlow.durationS,
      delayS: 0,
      segments: [],
      source: "none",
      unavailable: "no traffic flow source configured; duration is free-flow and ignores congestion. Set TOMTOM_API_KEY or HERE_API_KEY for live conditions.",
      freeFlowOnly: true
    };
  }
};
function severity(level) {
  switch (level) {
    case "severe":
      return 5;
    case "heavy":
      return 4;
    case "moderate":
      return 3;
    case "light":
      return 2;
    case "free":
      return 1;
    default:
      return 0;
  }
}
__name(severity, "severity");
function routeSummary(routed) {
  return {
    // `time` is absent on a straight-line fallback, in which case the caller's
    // own estimate is already an approximation and doubling it would be noise.
    durationS: routed.route.time ?? 0,
    roads: routed.route.steps.map((s) => s.turn).filter((t) => typeof t === "string" && t !== ""),
    geometry: routed.geometry
  };
}
__name(routeSummary, "routeSummary");
function waypoints(geometry, req) {
  const pts = [];
  const push = /* @__PURE__ */ __name((lon, lat) => {
    const s = `${lat.toFixed(5)},${lon.toFixed(5)}`;
    if (pts[pts.length - 1] !== s) pts.push(s);
  }, "push");
  push(req.from.lon, req.from.lat);
  const stride = Math.max(1, Math.floor(geometry.length / 100));
  for (let i = 0; i < geometry.length; i += stride) {
    const p = geometry[i];
    push(p[0], p[1]);
  }
  push(req.to.lon, req.to.lat);
  return pts;
}
__name(waypoints, "waypoints");

// ../../src/live.ts
var SLOPE_HEAT_RES = 16;
var SuperCarto = class _SuperCarto {
  static {
    __name(this, "SuperCarto");
  }
  sources;
  router;
  elevation;
  weather;
  traffic;
  transit;
  deriveHeat;
  defaultBudget;
  /** Per-area cache of compiled documents, keyed by envelope and layer set. */
  cache = /* @__PURE__ */ new Map();
  static CACHE_TTL_MS = 5 * 6e4;
  static CACHE_MAX = 128;
  constructor(opts = {}) {
    this.sources = opts.sources ?? [new OverpassSource(opts.overpass)];
    this.router = opts.router ?? new FeasibilityRouter();
    this.elevation = opts.elevation;
    this.weather = opts.weather === false ? void 0 : opts.weather ?? new OpenMeteoWeather(opts.openMeteo ?? {});
    this.traffic = new TrafficRouter(
      this.router,
      opts.traffic ?? [
        new TomTomFlow(opts.tomTom ?? {}),
        new HereFlow(opts.here ?? {})
      ]
    );
    this.transit = opts.transit;
    this.deriveHeat = opts.heat !== false;
    this.defaultBudget = opts.defaultBudget ?? 1024;
  }
  /**
   * Fetch real map data around a point and compile it for an agent.
   *
   * This is the "Google Maps for AI agents" call: coordinates in, a
   * token-budgeted topological graph out.
   */
  async maplet(req) {
    const radiusM = req.radiusM ?? 300;
    const bbox = normalizeBbox(bboxAround(req.lat, req.lon, radiusM));
    const budget = req.budget ?? this.defaultBudget;
    const fetched = await this.document(bbox, req.layers ?? [], req.signal);
    const doc = await this.withHeat(fetched.doc, bbox, req.signal);
    const result = toMaplet(
      { type: "FeatureCollection", features: [] },
      {
        doc,
        bbox,
        layers: req.layers,
        budget,
        ...req.compile ? { compile: req.compile } : {},
        radiusLabel: formatRadius(radiusM),
        // So the maplet advertises only the tools this instance can answer.
        capabilities: this.capabilities
      }
    );
    const explicit = req.layers !== void 0 && req.layers.length > 0;
    const wantsRoads = !explicit || req.layers.some((l) => l === "road" || l === "highway");
    const stripped = (result.graph.omitted ?? []).some((o) => o.layer === "landmark");
    if (result.graph.edges.length === 0 && stripped && wantsRoads) {
      const dropped = (result.graph.omitted ?? []).filter((o) => o.layer === "landmark").reduce((n, o) => n + o.count, 0);
      throw new Error(
        `no walkable network survived for ${req.lat},${req.lon} (radius ${radiusM}m): ${dropped} named places stripped for lack of streets. Pass layers: ['poi'] for a POI-only map, or retry - a degraded upstream fetch is the usual cause.`
      );
    }
    return {
      ...result,
      fetchedFrom: fetched.source,
      fetchMs: fetched.elapsedMs,
      warnings: fetched.warnings,
      sourceTruncated: fetched.truncated
    };
  }
  /**
   * One move of a session: the agent's stored SCR in, the +/-/~ delta out.
   *
   * This is the `localize` tool's engine. It fetches the new view's features,
   * re-ingests them under the *session's* envelope rather than the request
   * box's own, diffs against the agent's map, and returns the changed places
   * plus the replaced state. The agent keeps its map in local RAM; the LLM
   * context pays only for the diff.
   *
   * Moves outside the session envelope are refused rather than served with a
   * lying diff: a foreign grid would mark every untouched place dirty.
   */
  async moveView(req) {
    const prev = sessionDoc(req.scr);
    const env = prev.envelope;
    if (env.type !== "bbox") {
      throw new Error(
        "a session move needs a bbox session envelope; open a session with get_maplet first"
      );
    }
    const radiusM = req.radiusM ?? 300;
    const bbox = normalizeBbox(bboxAround(req.lat, req.lon, radiusM));
    if (!sessionEnvelopeContains(env, bbox)) {
      throw new Error(
        `the move leaves the session envelope (BBOX ${env.west} ${env.south} ${env.east} ${env.north}); a wrap-crossing view quantizes on the far side of the antimeridian and cannot share the session grid - call get_maplet again to open a new session`
      );
    }
    const fetched = await this.fetchFeatures(bbox, req.layers ?? [], req.signal);
    const move = moveMaplet(
      req.scr,
      { type: "FeatureCollection", features: fetched.features },
      {
        layers: req.layers ?? null,
        budget: req.budget ?? this.defaultBudget,
        radiusLabel: formatRadius(radiusM),
        capabilities: this.capabilities,
        ...req.compile ? { compile: req.compile } : {}
      }
    );
    return {
      ...move,
      fetchedFrom: fetched.source,
      fetchMs: fetched.elapsedMs,
      warnings: fetched.warnings,
      sourceTruncated: fetched.truncated
    };
  }
  /** Route between two points: feasibility by default, navigation with a verified router. */
  async route(req) {
    try {
      return await this.router.route(req);
    } catch {
      return straightLineRoute(req.from, req.to, req.mode);
    }
  }
  /**
   * Route with live congestion.
   *
   * Falls back to free flow, labelled, when no flow provider has a credential.
   * The `freeFlowOnly` flag is what the tool layer reads to tell the user their
   * ETA ignores traffic, so this is the difference between a useful answer and a
   * confidently wrong one.
   */
  async routeWithTraffic(req) {
    return this.traffic.route(req);
  }
  /**
   * Conditions at a point.
   *
   * Returns undefined only when weather is explicitly disabled. A source that is
   * configured but unreachable returns a result with `degraded` set and `now`
   * filled with NaN, which renders as `unknown` rather than as dry weather.
   */
  async weatherAt(lat, lon, forecastHours = 12, signal) {
    if (!this.weather) return void 0;
    return this.weather.fetch(lat, lon, forecastHours, signal);
  }
  /**
   * Attach derived heat layers to a document.
   *
   * Copy-on-write, so the cached document is never mutated. Two requests for the
   * same envelope with different layer filters would otherwise leave the first
   * one's heat describing the second one's data.
   *
   * Async because slope heat needs an elevation fetch, which is a network call.
   * Density is derived from data already in hand and costs nothing.
   */
  async withHeat(doc, bbox, signal) {
    if (!this.deriveHeat) return doc;
    const heat = [...doc.heat];
    const points = [];
    for (const f of doc.features) {
      if (f.geometry.kind !== "point") continue;
      if (!isNamedFeature(doc, f)) continue;
      points.push({ x: f.geometry.point.x, y: f.geometry.point.y, value: 1 });
    }
    if (points.length >= 3) {
      const density = densityToHeat(points, doc.envelope, { name: "poi_density" });
      if (density) heat.push(density);
    }
    if (this.elevation) {
      try {
        const grid = await this.elevationFor(bbox, SLOPE_HEAT_RES, signal);
        const scale = gridScaleFor(doc);
        if (grid && scale) {
          const slope = slopeToHeat(grid.values, grid.width, grid.height, {
            name: "slope",
            metresPerUnit: (scale.x + scale.y) / 2
          });
          if (slope) heat.push(slope);
        }
      } catch {
      }
    }
    return heat.length === doc.heat.length ? doc : { ...doc, heat };
  }
  /** Fetch and cache the compiled document for an area, reusing recent fetches. */
  async document(bbox, layers, signal) {
    const key = cacheKey(bbox, layers);
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < _SuperCarto.CACHE_TTL_MS) {
      return { doc: hit.doc, source: "cache", elapsedMs: 0, warnings: [], truncated: false };
    }
    const res = await this.fetchFeatures(bbox, layers, signal);
    const doc = fromGeoJson(
      { type: "FeatureCollection", features: res.features },
      { envelope: { type: "bbox", ...bbox }, source: res.source }
    );
    this.remember(key, doc);
    return {
      doc,
      source: res.source,
      elapsedMs: res.elapsedMs,
      warnings: res.warnings,
      truncated: res.truncated
    };
  }
  /**
   * Fetch through the sources, trying each until one answers.
   *
   * Split out of `document` so session moves can ingest the same features
   * under the *session's* envelope rather than the request box's own - the
   * one-envelope rule that makes the diff compare geometry exactly.
   */
  async fetchFeatures(bbox, layers, signal) {
    const request = { bbox, layers, maxFeatures: 5e4, signal };
    let lastError;
    for (const source of this.sources) {
      if (!await source.available()) continue;
      try {
        return await source.fetch(request);
      } catch (err) {
        lastError = err;
      }
    }
    throw new Error(
      `no source could serve the request${lastError ? `: ${String(lastError)}` : ""}`
    );
  }
  remember(key, doc) {
    if (this.cache.size >= _SuperCarto.CACHE_MAX) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== void 0) this.cache.delete(oldest);
    }
    this.cache.set(key, { doc, at: Date.now() });
  }
  /** Full SCR text for an area, for machine-side caching or binary encoding. */
  async scr(bbox, layers = [], signal) {
    const { doc } = await this.document(bbox, layers, signal);
    return encodeDocument(doc, { group: false });
  }
  /** Elevation grid for an area, when a terrain source is configured. */
  async elevationFor(bbox, res = 32, signal) {
    if (!this.elevation) return void 0;
    try {
      return await this.elevation.fetch(normalizeBbox(bbox), res, signal);
    } catch {
      return void 0;
    }
  }
  /** Number of cached documents, for diagnostics. */
  get cacheSize() {
    return this.cache.size;
  }
  /**
   * Whether elevation can actually be answered.
   *
   * The MCP layer uses this to decide whether to advertise `get_terrain` at
   * all, so an operator is never handed a tool that cannot work.
   */
  get hasElevation() {
    return this.elevation !== void 0;
  }
  /** Whether weather can be answered. Gates advertising `get_weather`. */
  get hasWeather() {
    return this.weather !== void 0;
  }
  /**
   * Whether live traffic can be answered.
   *
   * Gates advertising `get_traffic`. The distinction from `hasWeather` matters:
   * weather works with no credential, traffic never does, so `get_traffic` is
   * absent from the tool list unless a key is present. Advertising it anyway
   * would produce an agent that confidently quotes a free-flow ETA.
   */
  get hasTraffic() {
    return this.traffic.hasFlow;
  }
  /**
   * Whether the transit schedule can be answered.
   *
   * Gates advertising `get_transit`. A schedule tool with no feed behind it
   * would teach a model to trust a "no feed" answer that reads like "no
   * service" - an honest refusal turned into a lie about buses that run.
   */
  get hasTransit() {
    return this.transit !== void 0;
  }
  /**
   * The transit slice for a point: stops, routes, and schedule-derived service
   * window, from the configured GTFS feed.
   *
   * The underlying query is synchronous (the feed is local data), but the
   * method stays async so every live entry point answers the same way and a
   * future remote schedule source needs no call-site changes.
   *
   * Throws when no feed is configured. The tool layer never advertises
   * `get_transit` in that state, so this is a plumbing error, not an answer.
   */
  async transitAt(req) {
    if (!this.transit) {
      throw new Error("no GTFS feed configured for this deployment");
    }
    return this.transit.querySlice({
      ...req,
      radiusM: req.radiusM ?? 400,
      budget: req.budget ?? this.defaultBudget
    });
  }
  /** The full capability set, used for tool advertisement. */
  get capabilities() {
    return {
      elevation: this.hasElevation,
      weather: this.hasWeather,
      traffic: this.hasTraffic,
      transit: this.hasTransit
    };
  }
  /** Clear the document cache. */
  clearCache() {
    this.cache.clear();
  }
};
function formatRadius(m) {
  return m >= 1e3 ? `${(m / 1e3).toFixed(1)}km` : `${Math.round(m)}m`;
}
__name(formatRadius, "formatRadius");
function isNamedFeature(doc, f) {
  if (f.attrSet === 0) return false;
  const set = doc.attrSets.get(f.attrSet);
  if (!set) return false;
  for (const p of set.props) {
    if (doc.strings.get(p.key) !== "name") continue;
    if (p.value.t === "ref") {
      const s = doc.strings.get(p.value.ref);
      if (s !== void 0 && s !== "") return true;
    }
  }
  return false;
}
__name(isNamedFeature, "isNamedFeature");
function cacheKey(bbox, layers) {
  const b = [bbox.west, bbox.south, bbox.east, bbox.north].map((n) => n.toFixed(5)).join(",");
  return `${b}|${[...layers].sort().join(",")}`;
}
__name(cacheKey, "cacheKey");

// ../../src/source/mvt.ts
var WIRE_VARINT = 0;
var WIRE_64BIT = 1;
var WIRE_LEN = 2;
var WIRE_32BIT = 5;
var Reader = class {
  constructor(buf) {
    this.buf = buf;
  }
  buf;
  static {
    __name(this, "Reader");
  }
  pos = 0;
  get done() {
    return this.pos >= this.buf.length;
  }
  varint() {
    let result = 0;
    let shift = 0;
    while (this.pos < this.buf.length) {
      const byte = this.buf[this.pos++];
      result += (byte & 127) * 2 ** shift;
      if ((byte & 128) === 0) return result;
      shift += 7;
      if (shift > 63) break;
    }
    return result;
  }
  svarint() {
    const v = this.varint();
    return v % 2 === 1 ? -(v + 1) / 2 : v / 2;
  }
  bytes() {
    const len = this.varint();
    const out = this.buf.subarray(this.pos, this.pos + len);
    this.pos += len;
    return out;
  }
  skip(wire) {
    switch (wire) {
      case WIRE_VARINT:
        this.varint();
        return;
      case WIRE_64BIT:
        this.pos += 8;
        return;
      case WIRE_LEN:
        this.pos += this.varint();
        return;
      case WIRE_32BIT:
        this.pos += 4;
        return;
      default:
        this.pos = this.buf.length;
    }
  }
  double() {
    const v = new DataView(
      this.buf.buffer,
      this.buf.byteOffset + this.pos,
      8
    ).getFloat64(0, true);
    this.pos += 8;
    return v;
  }
  float() {
    const v = new DataView(
      this.buf.buffer,
      this.buf.byteOffset + this.pos,
      4
    ).getFloat32(0, true);
    this.pos += 4;
    return v;
  }
};
function decodeMvt(buf) {
  const r = new Reader(buf);
  const layers = [];
  while (!r.done) {
    const key = r.varint();
    const field = key >> 3;
    const wire = key & 7;
    if (field === 3 && wire === WIRE_LEN) {
      layers.push(decodeLayer(r.bytes()));
    } else {
      r.skip(wire);
    }
  }
  return { layers };
}
__name(decodeMvt, "decodeMvt");
function decodeLayer(buf) {
  const r = new Reader(buf);
  const layer = { name: "", extent: 4096, features: [] };
  const keys = [];
  const values = [];
  const rawFeatures = [];
  while (!r.done) {
    const key = r.varint();
    const field = key >> 3;
    const wire = key & 7;
    switch (field) {
      // Field numbers are MVT 2.1. In 2.1 the TileLayer message was renumbered:
      // name is 1, features 2, keys 3, values 4, extent 5, and version 15. The
      // older layout - version 1, keys 15, values 16 - is what a decoder written
      // against spec v1 uses, and against a real tile every field is read as the
      // wrong type: name is consumed as a varint, and keys and values are never
      // found, so the layer comes back nameless with no features and no
      // properties. Every tile that exists in the wild is 2.1.
      case 1:
        layer.name = utf8(r.bytes());
        break;
      case 2:
        if (wire === WIRE_LEN) rawFeatures.push(decodeFeature2(r.bytes()));
        else r.skip(wire);
        break;
      case 3:
        keys.push(utf8(r.bytes()));
        break;
      case 4:
        values.push(decodeValue(r.bytes()));
        break;
      case 5:
        layer.extent = r.varint();
        break;
      case 15:
        r.varint();
        break;
      default:
        r.skip(wire);
    }
  }
  for (const f of rawFeatures) {
    const resolved = {};
    for (const [k, v] of Object.entries(f.properties)) {
      const idx = typeof v === "number" ? v : -1;
      if (idx >= 0 && idx < keys.length && k.startsWith("@")) {
        const value = values[idx];
        if (value !== void 0) resolved[keys[Number(k.slice(1))] ?? k] = value;
      }
    }
    layer.features.push({
      id: f.id,
      properties: resolved,
      geometry: f.geometry
    });
  }
  return layer;
}
__name(decodeLayer, "decodeLayer");
function decodeValue(buf) {
  const r = new Reader(buf);
  let out = {};
  while (!r.done) {
    const key = r.varint();
    const field = key >> 3;
    const wire = key & 7;
    switch (field) {
      case 1:
        out = { string: utf8(r.bytes()) };
        break;
      case 2:
        out = { double: r.float() };
        break;
      case 3:
        out = { double: r.double() };
        break;
      case 4:
        out = { int: Number(r.varint()) };
        break;
      case 5:
        out = { uint: r.varint() };
        break;
      case 6:
        out = { sint: r.svarint() };
        break;
      case 7:
        out = { bool: r.varint() !== 0 };
        break;
      default:
        r.skip(wire);
    }
  }
  return out;
}
__name(decodeValue, "decodeValue");
function decodeFeature2(buf) {
  const r = new Reader(buf);
  const out = {
    id: 0,
    properties: {},
    geometry: { type: 1, rings: [] }
  };
  const tags = [];
  while (!r.done) {
    const key = r.varint();
    const field = key >> 3;
    const wire = key & 7;
    switch (field) {
      case 1:
        out.id = r.varint();
        break;
      case 2: {
        const packed = r.bytes();
        const pr = new Reader(packed);
        while (!pr.done) tags.push(pr.varint());
        break;
      }
      case 3:
        out.geometry.type = r.varint();
        break;
      case 4: {
        const packed = r.bytes();
        const gr = new Reader(packed);
        out.geometry.rings = readCommands(gr);
        break;
      }
      default:
        r.skip(wire);
    }
  }
  for (let i = 0; i + 1 < tags.length; i += 2) {
    out.properties[`@${tags[i]}`] = tags[i + 1];
  }
  return out;
}
__name(decodeFeature2, "decodeFeature");
function readCommands(r) {
  const rings = [];
  let ring = [];
  let x = 0;
  let y = 0;
  while (!r.done) {
    const header = r.varint();
    const id = header & 7;
    const count = header >> 3;
    if (id === 1) {
      if (ring.length > 0) {
        rings.push(ring);
        ring = [];
      }
      for (let i = 0; i < count; i++) {
        x += Math.round(r.svarint());
        y += Math.round(r.svarint());
        ring.push([x, y]);
      }
    } else if (id === 2) {
      for (let i = 0; i < count; i++) {
        x += Math.round(r.svarint());
        y += Math.round(r.svarint());
        ring.push([x, y]);
      }
    } else if (id === 7) {
      const first = ring[0];
      if (first) {
        ring.push([first[0], first[1]]);
        rings.push(ring);
        ring = [];
      }
    }
  }
  if (ring.length > 0) rings.push(ring);
  return rings;
}
__name(readCommands, "readCommands");
function utf8(buf) {
  return new TextDecoder().decode(buf);
}
__name(utf8, "utf8");

// ../../src/source/protomaps.ts
var PMTILES_MAGIC = "PMTiles";
var HEADER_BYTES = 127;
var PROTOMAPS_DEMO = "https://demo-bucket.protomaps.com/v4.pmtiles";
var PmtilesArchive = class {
  constructor(url, fetchImpl = plainFetch) {
    this.url = url;
    this.fetchImpl = fetchImpl;
  }
  url;
  fetchImpl;
  static {
    __name(this, "PmtilesArchive");
  }
  header;
  entries;
  headerPromise;
  /** Decoded directories, keyed by their byte offset in the archive. */
  directories = /* @__PURE__ */ new Map();
  get remote() {
    return this.url.startsWith("http://") || this.url.startsWith("https://");
  }
  async info() {
    if (this.header) return this.header;
    if (!this.headerPromise) this.headerPromise = this.readHeader();
    this.header = await this.headerPromise;
    return this.header;
  }
  async readHeader() {
    const bytes = await this.read(0, HEADER_BYTES);
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const magic = new TextDecoder().decode(bytes.subarray(0, 7));
    if (magic !== PMTILES_MAGIC) {
      throw new Error(`not a PMTiles archive (magic "${magic}")`);
    }
    const u64 = /* @__PURE__ */ __name((off) => {
      const v = dv.getBigUint64(off, true);
      return Number(v);
    }, "u64");
    return {
      version: bytes[7],
      rootOffset: u64(8),
      rootLength: u64(16),
      metadataOffset: u64(24),
      metadataLength: u64(32),
      leafOffset: u64(40),
      leafLength: u64(48),
      dataOffset: u64(56),
      dataLength: u64(64),
      addressedTiles: u64(72),
      tileEntries: u64(80),
      tileContents: u64(88),
      clustered: bytes[96] === 1,
      directoryCompression: bytes[97],
      tileCompression: bytes[98],
      tileType: bytes[99],
      minZoom: bytes[100],
      maxZoom: bytes[101],
      centerZoom: dv.getFloat32(105, true)
    };
  }
  /**
   * The root directory's entries.
   *
   * For a large archive these are pointers at leaf directories rather than
   * entries that address tiles; `tile()` follows them per lookup.
   */
  async directory() {
    const h = await this.info();
    return this.directoryAt(h.rootOffset, h.rootLength);
  }
  /** A directory blob by offset, decoded once and shared across lookups. */
  async directoryAt(offset, length) {
    if (offset === (await this.info()).rootOffset) {
      if (!this.entries) {
        this.entries = await this.decodeDirectoryBlob(offset, length);
      }
      return this.entries;
    }
    let cached = this.directories.get(offset);
    if (!cached) {
      cached = this.decodeDirectoryBlob(offset, length);
      if (this.directories.size >= 16) {
        const oldest = this.directories.keys().next().value;
        if (oldest !== void 0) this.directories.delete(oldest);
      }
      this.directories.set(offset, cached);
    }
    return cached;
  }
  async decodeDirectoryBlob(offset, length) {
    const h = await this.info();
    const raw = await this.read(offset, length);
    const buf = await decompress(raw, h.directoryCompression, "directory");
    const root = decodeDirectory(buf);
    if (root.length === 0 && h.leafLength > 0) {
      throw new Error("PMTiles archive has an empty root directory");
    }
    return root;
  }
  /** Byte range read, from a remote archive or a local file. */
  async read(offset, length) {
    if (this.remote) {
      const res = await this.fetchImpl(this.url, {
        headers: { Range: `bytes=${offset}-${offset + length - 1}` }
      });
      if (!res.ok && res.status !== 206) {
        throw new Error(`PMTiles archive responded ${res.status}`);
      }
      return new Uint8Array(await res.arrayBuffer());
    }
    const specs = ["node:fs/promises"];
    const { readFile } = await import(specs[0]);
    const fh = await readFile(this.url);
    return new Uint8Array(fh.buffer, fh.byteOffset + offset, length);
  }
  /**
   * Tile bytes, or undefined when the archive has no tile at that id.
   *
   * Large archives do not address tiles from the root: an entry there with
   * `runLength === 0` points at a leaf directory, and lookup descends root →
   * leaf (at most three levels per the v3 layout) until an entry with data
   * resolves. A small archive resolves on the first pass, unchanged.
   */
  async tile(tileId) {
    const h = await this.info();
    let dirOffset = h.rootOffset;
    let dirLength = h.rootLength;
    for (let depth = 0; depth < 4; depth++) {
      const entries = await this.directoryAt(dirOffset, dirLength);
      const entry = findEntry(entries, tileId);
      if (!entry) return void 0;
      if (entry.runLength === 0) {
        dirOffset = h.leafOffset + entry.offset;
        dirLength = entry.length;
        continue;
      }
      const raw = await this.read(h.dataOffset + entry.offset, entry.length);
      return await decompress(raw, h.tileCompression, "tile");
    }
    throw new Error("PMTiles archive exceeds maximum directory depth");
  }
  /** Vector tile as MVT, or undefined when the archive is not vector. */
  async vectorTile(tileId) {
    const h = await this.info();
    if (h.tileType !== 1) return void 0;
    const bytes = await this.tile(tileId);
    if (!bytes) return void 0;
    try {
      return decodeMvt(bytes);
    } catch {
      return void 0;
    }
  }
};
function findEntry(entries, tileId) {
  let lo = 0;
  let hi = entries.length - 1;
  while (lo <= hi) {
    const mid = lo + hi >> 1;
    const e = entries[mid];
    if (tileId < e.tileId) hi = mid - 1;
    else if (tileId >= e.tileId + e.runLength) lo = mid + 1;
    else return e;
  }
  if (hi >= 0 && entries[hi].runLength === 0) return entries[hi];
  return void 0;
}
__name(findEntry, "findEntry");
function decodeDirectory(buf) {
  const out = [];
  let pos = 0;
  const varint = /* @__PURE__ */ __name(() => {
    let result = 0;
    let shift = 0;
    while (pos < buf.length) {
      const b = buf[pos++];
      result += (b & 127) * 2 ** shift;
      if ((b & 128) === 0) return result;
      shift += 7;
    }
    return result;
  }, "varint");
  const count = varint();
  if (count <= 0 || count > 2e5) return out;
  const ids = [];
  let lastId = 0;
  for (let i = 0; i < count; i++) {
    lastId += varint();
    ids.push(lastId);
  }
  const runLengths = [];
  for (let i = 0; i < count; i++) runLengths.push(varint());
  const lengths = [];
  for (let i = 0; i < count; i++) lengths.push(varint());
  for (let i = 0; i < count; i++) {
    const value = varint();
    let offset;
    if (value === 0 && i > 0) {
      const prev = out[i - 1];
      offset = prev.offset + prev.length;
    } else {
      offset = value - 1;
    }
    out.push({ tileId: ids[i], offset, length: lengths[i], runLength: runLengths[i] });
  }
  return out;
}
__name(decodeDirectory, "decodeDirectory");
var ProtomapsSource = class {
  static {
    __name(this, "ProtomapsSource");
  }
  name;
  description = "PMTiles vector archive over HTTP range requests";
  archive;
  maxZoom;
  maxTiles;
  maxFeatures;
  keep;
  constructor(opts) {
    this.archive = new PmtilesArchive(opts.url, opts.fetchImpl);
    this.name = opts.name ?? (opts.url === PROTOMAPS_DEMO ? "protomaps" : "pmtiles");
    this.maxZoom = opts.maxZoom ?? 14;
    this.maxTiles = opts.maxTiles ?? 16;
    this.maxFeatures = opts.maxFeatures ?? 0;
    this.keep = new Set(opts.layers ?? []);
  }
  async available() {
    try {
      await this.archive.info();
      return true;
    } catch {
      return false;
    }
  }
  async fetch(req) {
    const started = Date.now();
    const warnings = [];
    const h = await this.archive.info();
    if (h.tileType !== 1) {
      throw new Error(
        `archive holds raster tiles (type ${h.tileType}); supercarto needs vector tiles`
      );
    }
    const zoom = zoomFor(req.bbox, h.maxZoom, this.maxZoom);
    const allTiles = tilesFor2(req.bbox, zoom);
    const capped = allTiles.slice(0, this.maxTiles);
    if (capped.length < allTiles.length) {
      warnings.push(
        `requested ${allTiles.length} tiles at z${zoom}, fetched ${capped.length}; the rest of this area is not shown`
      );
    }
    const features = [];
    const seen = /* @__PURE__ */ new Set();
    for (const { id, x, y } of capped) {
      const tile = await this.archive.vectorTile(id);
      if (!tile) continue;
      for (const layer of tile.layers) {
        if (this.keep.size > 0 && !this.keep.has(layer.name)) continue;
        for (const f of layer.features) {
          const fid = f.id || 0;
          const key = fid * 31 + layerNameHash(layer);
          if (fid !== 0 && seen.has(key)) continue;
          if (fid !== 0) seen.add(key);
          const g = toGeoJson(f.geometry.rings, layer.extent, x, y, zoom);
          if (!g) continue;
          features.push({
            type: "Feature",
            ...fid !== 0 ? { id: fid } : {},
            properties: {
              ...propertiesOf(f.properties),
              class: layer.name,
              _tile: `${zoom}/${id}`
            },
            geometry: g
          });
          if (features.length >= this.featureCap(req)) {
            return {
              features,
              source: this.name,
              truncated: true,
              elapsedMs: Date.now() - started,
              warnings: [
                ...warnings,
                `stopped at the ${this.featureCap(req)} feature cap for this request`
              ]
            };
          }
        }
      }
    }
    return {
      features,
      source: this.name,
      truncated: capped.length < allTiles.length,
      elapsedMs: Date.now() - started,
      warnings
    };
  }
  /**
   * The feature limit in force: the source's own cap when set lower than the
   * caller's, otherwise the caller's.
   */
  featureCap(req) {
    if (this.maxFeatures > 0 && this.maxFeatures < req.maxFeatures) {
      return this.maxFeatures;
    }
    return req.maxFeatures;
  }
};
function layerNameHash(layer) {
  let h = 0;
  for (let i = 0; i < layer.name.length; i++) h = h * 31 + layer.name.charCodeAt(i) | 0;
  return h;
}
__name(layerNameHash, "layerNameHash");
function propertiesOf(props) {
  const out = {};
  for (const [k, v] of Object.entries(props)) {
    if (v === null || v === void 0) continue;
    if (typeof v === "string") out[k] = v;
    else if (typeof v === "number") out[k] = v;
    else if (typeof v === "boolean") out[k] = v;
    else if (typeof v === "object") {
      const o = v;
      if (typeof o.string === "string") out[k] = o.string;
      else if (typeof o.double === "number") out[k] = o.double;
      else if (typeof o.int === "number") out[k] = o.int;
      else if (typeof o.uint === "number") out[k] = o.uint;
      else if (typeof o.sint === "number") out[k] = o.sint;
      else if (typeof o.bool === "boolean") out[k] = o.bool;
    }
  }
  return out;
}
__name(propertiesOf, "propertiesOf");
function toGeoJson(rings, extent, x0, y0, zoom) {
  if (rings.length === 0) return void 0;
  const size = 2 ** zoom;
  const toLonLat = /* @__PURE__ */ __name((c) => {
    const u = c[0] / extent;
    const v = c[1] / extent;
    const lon = (x0 + u) / size * 360 - 180;
    const lat = latFromTileY(y0 + v, size);
    return [round3(lon, 7), round3(lat, 7)];
  }, "toLonLat");
  const mapped = rings.map((r) => r.map(toLonLat));
  if (mapped.length === 1 && mapped[0].length === 1) {
    return { type: "Point", coordinates: mapped[0][0] };
  }
  const first = mapped[0];
  const closed = first.length > 3 && first[0][0] === first[first.length - 1][0] && first[0][1] === first[first.length - 1][1];
  if (closed) {
    const out2 = [];
    for (const ring of mapped) {
      if (ring.length >= 4) out2.push(ring);
    }
    if (out2.length === 0) return void 0;
    return { type: "Polygon", coordinates: out2 };
  }
  const out = mapped.filter((r) => r.length >= 2);
  if (out.length === 0) return void 0;
  if (out.length === 1) return { type: "LineString", coordinates: out[0] };
  return { type: "MultiLineString", coordinates: out };
}
__name(toGeoJson, "toGeoJson");
function latFromTileY(y, size) {
  const t = Math.PI * (1 - 2 * y / size);
  return 180 / Math.PI * Math.atan(Math.sinh(t));
}
__name(latFromTileY, "latFromTileY");
function tilesFor2(b, z) {
  const n = 2 ** z;
  const w = Math.max(0, Math.min(n - 1, lonToX(b.west, n)));
  const e = Math.max(0, Math.min(n - 1, lonToX(b.east, n)));
  const s = Math.max(0, Math.min(n - 1, latToY(b.north, n)));
  const t = Math.max(0, Math.min(n - 1, latToY(b.south, n)));
  const out = [];
  for (let y = s; y <= t; y++) {
    for (let x = w; x <= e; x++) out.push({ id: hilbertTileId(z, x, y), x, y });
  }
  return out;
}
__name(tilesFor2, "tilesFor");
function hilbertTileId(z, x, y) {
  let rx, ry, d = 0;
  for (let s = 1 << z - 1; s > 0; s >>= 1) {
    rx = (x & s) > 0 ? 1 : 0;
    ry = (y & s) > 0 ? 1 : 0;
    d += s * s * (3 * rx ^ ry);
    if (ry === 0) {
      if (rx === 1) {
        x = s - 1 - x;
        y = s - 1 - y;
      }
      const t = x;
      x = y;
      y = t;
    }
  }
  return d + tileIdBase(z);
}
__name(hilbertTileId, "hilbertTileId");
function tileIdBase(z) {
  return (4 ** z - 1) / 3 | 0;
}
__name(tileIdBase, "tileIdBase");
function lonToX(lon, n) {
  return Math.floor((lon + 180) / 360 * n);
}
__name(lonToX, "lonToX");
function latToY(lat, n) {
  const clamped = Math.max(-85.05112878, Math.min(85.05112878, lat));
  const rad = clamped * Math.PI / 180;
  return Math.floor((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2 * n);
}
__name(latToY, "latToY");
function zoomFor(b, archiveMax, cap) {
  const midLat = (b.north + b.south) / 2;
  const widthM = Math.abs(b.east - b.west) * 111320 * Math.cos(midLat * Math.PI / 180);
  const want = Math.max(0, Math.ceil(Math.log2(156543 / Math.max(1, widthM))));
  return Math.max(12, Math.min(cap, archiveMax, want));
}
__name(zoomFor, "zoomFor");
function round3(n, places) {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}
__name(round3, "round");

// src/worker.ts
var MAX_RADIUS_M = 25e3;
var DEFAULT_BUDGET = 1024;
var MAX_TOKENS = 16384;
var ATTRIBUTION = "\xA9 OpenStreetMap contributors (ODbL)";
var DEFAULT_OVERPASS_INTERPRETER = "https://overpass-api.de/api/interpreter";
var RATE_WINDOW_MS = 6e4;
var DEFAULT_MAPLET_PER_MINUTE = 30;
var PLANET_BUILD_ROOT = "https://build.protomaps.com";
var PLANET_BUILD_INDEX = "https://build-metadata.protomaps.dev/builds.json";
var PINNED_PLANET_BUILD = "https://build.protomaps.com/20261022.pmtiles";
async function resolvePmtilesUrl(explicit) {
  if (explicit) return explicit;
  try {
    const res = await fetch(PLANET_BUILD_INDEX, { signal: AbortSignal.timeout(5e3) });
    if (res.ok) {
      const builds = await res.json();
      const keys = builds.map((b) => b.key).filter((k) => typeof k === "string" && /^\d{8}\.pmtiles$/.test(k)).sort();
      const latest = keys[keys.length - 1];
      if (latest) return `${PLANET_BUILD_ROOT}/${latest}`;
    }
  } catch {
  }
  return PINNED_PLANET_BUILD;
}
__name(resolvePmtilesUrl, "resolvePmtilesUrl");
function createHandler(opts = {}) {
  const carto = opts.carto ? Promise.resolve(opts.carto) : buildDefaultCarto(opts);
  const maxTokens = opts.maxTokens ?? MAX_TOKENS;
  const origin = opts.corsOrigin ?? "*";
  const mapletLimit = opts.mapletPerMinute ?? DEFAULT_MAPLET_PER_MINUTE;
  const overpassStatusUrl = (opts.overpassEndpoint ?? DEFAULT_OVERPASS_INTERPRETER).replace(/interpreter$/i, "status");
  let health = { at: 0, ok: false, detail: "not probed yet" };
  const KNOWN_OVERPASS_INSTANCES = [
    { root: "https://overpass-api.de/api" },
    { root: "https://overpass.kumi.systems/api" },
    { root: "https://overpass.private.coffee/api" },
    { root: "https://gall.openstreetmap.de/api" }
  ];
  return /* @__PURE__ */ __name(async function handle(req) {
    try {
      return await route(req);
    } catch (err) {
      return json({ "Access-Control-Allow-Origin": origin }, 502, {
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }, "handle");
  async function route(req) {
    const url = new URL(req.url);
    const probeParam = url.searchParams.get("endpoint");
    const probedUrl = KNOWN_OVERPASS_INSTANCES.some(
      (i) => probeParam !== null && probeParam.replace(/\/+$/, "").endsWith(i.root.replace("https://", ""))
    ) ? `${probeParam}/status` : overpassStatusUrl;
    const extraHeaders = {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "content-type"
    };
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: extraHeaders });
    }
    if (url.pathname === "/healthz") {
      const probe = probeParam !== null ? await probeStatus(probedUrl) : await (async () => {
        await refreshHealth();
        return health;
      })();
      return json(extraHeaders, probe.ok ? 200 : 503, {
        ok: probe.ok,
        overpass: probe.detail
      });
    }
    if (url.pathname === "/") {
      return json(extraHeaders, 200, indexBody());
    }
    if (url.pathname === "/maplet") {
      const retry = rateLimited(req, mapletLimit);
      if (retry > 0) {
        return json(
          { ...extraHeaders, "Retry-After": String(retry) },
          429,
          { error: mapletLimitMessage(mapletLimit) }
        );
      }
      return await mapletRoute(url, req, extraHeaders, maxTokens);
    }
    if (url.pathname === "/scr") {
      return scrRoute(url, extraHeaders);
    }
    if (url.pathname === "/daylight") {
      return daylightRoute(url, extraHeaders);
    }
    if (url.pathname === "/weather") {
      return await weatherRoute(url, extraHeaders);
    }
    if (url.pathname === "/terrain") {
      return await terrainRoute(url, extraHeaders);
    }
    return json(extraHeaders, 404, { error: "not found", routes: servedRoutes(), unavailable: unavailableBody() });
  }
  __name(route, "route");
  ;
  async function mapletRoute(url, req, headers, cap) {
    let body = {};
    if (req.method === "POST") {
      try {
        const parsed = await req.json();
        if (parsed && typeof parsed === "object") body = parsed;
      } catch {
        return json(headers, 400, { error: "POST body must be JSON parameters" });
      }
    }
    const lat = numParam(body, url, "lat");
    const lon = numParam(body, url, "lon");
    if (lat === void 0 || lon === void 0) {
      return json(headers, 400, { error: "lat and lon are required" });
    }
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      return json(headers, 400, {
        error: "lat must be in [-90,90] and lon in [-180,180]"
      });
    }
    const radiusM = clamp(numParam(body, url, "radiusM", 300), 1, MAX_RADIUS_M);
    const budget = clamp(numParam(body, url, "budget", DEFAULT_BUDGET), 64, cap);
    const layers = url.searchParams.get("layers")?.split(",").map((s) => s.trim()).filter(Boolean);
    let result;
    try {
      result = await (await carto).maplet({ lat, lon, radiusM, layers, budget });
    } catch (err) {
      return json(headers, 502, {
        error: err instanceof Error ? err.message : String(err)
      });
    }
    attributionHeaderOn(headers);
    const format = url.searchParams.get("format") ?? "yaml";
    if (format === "yaml" || format === "text") {
      const metrics = {
        ...result.metrics,
        fetchedFrom: result.fetchedFrom,
        fetchMs: result.fetchMs,
        warnings: result.warnings,
        sourceTruncated: result.sourceTruncated
      };
      return new Response(result.yaml + (result.yaml.endsWith("\n") ? "" : "\n"), {
        status: 200,
        headers: {
          ...headers,
          "content-type": "text/plain; charset=utf-8",
          "X-Maplet-Metrics": JSON.stringify(metrics)
        }
      });
    }
    return json(headers, 200, {
      yaml: result.yaml,
      metrics: result.metrics,
      fetchedFrom: result.fetchedFrom,
      fetchMs: result.fetchMs,
      warnings: result.warnings,
      sourceTruncated: result.sourceTruncated,
      partial: result.graph.partial,
      omitted: result.graph.omitted
    });
  }
  __name(mapletRoute, "mapletRoute");
  async function scrRoute(url, headers) {
    const bbox = parseBbox(url.searchParams.get("bbox"));
    if (!bbox) {
      return json(headers, 400, { error: 'bbox must be "west,south,east,north"' });
    }
    const layers = url.searchParams.get("layers")?.split(",").map((s) => s.trim()).filter(Boolean) ?? [];
    let text;
    try {
      text = await (await carto).scr(bbox, layers);
    } catch (err) {
      return json(headers, 502, {
        error: err instanceof Error ? err.message : String(err)
      });
    }
    attributionHeaderOn(headers);
    return new Response(text, {
      status: 200,
      headers: { ...headers, "content-type": "text/plain; charset=utf-8" }
    });
  }
  __name(scrRoute, "scrRoute");
  function daylightRoute(url, headers) {
    const lat = numParam({}, url, "lat");
    const lon = numParam({}, url, "lon");
    if (lat === void 0 || lon === void 0) {
      return json(headers, 400, { error: "lat and lon are required" });
    }
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      return json(headers, 400, { error: "lat must be in [-90,90] and lon in [-180,180]" });
    }
    let at = /* @__PURE__ */ new Date();
    const atArg = url.searchParams.get("at");
    if (atArg !== null && atArg !== "") {
      at = new Date(atArg);
      if (Number.isNaN(at.getTime())) {
        return json(headers, 400, { error: `could not read "${atArg}" as an ISO 8601 instant` });
      }
    }
    const sun = sunPosition(lat, lon, at);
    const { sunrise: _sr, sunset: _ss, ...rest } = sun;
    const body = sun.polar === false ? { ...rest, sunrise: sun.sunrise, sunset: sun.sunset, needsLight: needsLight(sun) } : { ...rest, needsLight: needsLight(sun) };
    return json(headers, 200, { lat, lon, at: at.toISOString(), ...body });
  }
  __name(daylightRoute, "daylightRoute");
  async function weatherRoute(url, headers) {
    const lat = numParam({}, url, "lat");
    const lon = numParam({}, url, "lon");
    if (lat === void 0 || lon === void 0) {
      return json(headers, 400, { error: "lat and lon are required" });
    }
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      return json(headers, 400, { error: "lat must be in [-90,90] and lon in [-180,180]" });
    }
    const hours = clamp(numParam({}, url, "hours", 12), 1, 48);
    const w = await (await carto).weatherAt(lat, lon, hours);
    if (!w) {
      return json(headers, 404, { error: "weather is not configured for this deployment" });
    }
    if (w.degraded) {
      return json(headers, 503, {
        error: `weather unavailable: ${w.degraded}`
      });
    }
    return json(headers, 200, w);
  }
  __name(weatherRoute, "weatherRoute");
  async function terrainRoute(url, headers) {
    const lat = numParam({}, url, "lat");
    const lon = numParam({}, url, "lon");
    if (lat === void 0 || lon === void 0) {
      return json(headers, 400, { error: "lat and lon are required" });
    }
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      return json(headers, 400, { error: "lat must be in [-90,90] and lon in [-180,180]" });
    }
    const radiusM = clamp(numParam({}, url, "radiusM", 1e3), 1, MAX_RADIUS_M);
    const samples = clamp(numParam({}, url, "samples", 16), 4, 128);
    const grid = await (await carto).elevationFor(normalizeBbox(bboxAround(lat, lon, radiusM)), samples);
    if (!grid) {
      return json(headers, 404, { error: "no elevation source is configured for this deployment" });
    }
    if (!hasDecodedSamples(grid)) {
      return json(headers, 503, {
        error: "elevation tiles were fetched but none decoded into samples: the endpoint did not serve a readable Terrarium tile body (PNG or raw) for this area"
      });
    }
    const values = Array.from(grid.values).filter((v) => Number.isFinite(v));
    values.sort((a, b) => a - b);
    const lo = values[0];
    const hi = values[values.length - 1];
    const text = [
      `elevation over ${formatRadius2(radiusM)} around ${lat.toFixed(4)},${lon.toFixed(4)}`,
      `min: ${(lo ?? 0).toFixed(1)}m`,
      `max: ${(hi ?? 0).toFixed(1)}m`,
      `range: ${((hi ?? 0) - (lo ?? 0)).toFixed(1)}m`,
      "",
      "Note: elevation is relative to sea level, and the source may be coarse at this radius."
    ].join("\n");
    return new Response(text, {
      status: 200,
      headers: { ...headers, "content-type": "text/plain; charset=utf-8" }
    });
  }
  __name(terrainRoute, "terrainRoute");
  async function refreshHealth() {
    const now = Date.now();
    if (now - health.at < 6e4) return;
    const probed = await probeStatus(overpassStatusUrl);
    health = { at: now, ok: probed.ok, detail: probed.detail };
  }
  __name(refreshHealth, "refreshHealth");
  async function probeStatus(statusUrl, root = statusUrl.replace(/\/status$/, "")) {
    try {
      const res = await fetch(statusUrl, { signal: AbortSignal.timeout(5e3) });
      if (res.ok) {
        return { ok: true, detail: `reachable (HTTP ${res.status})` };
      }
      if (res.status === 404) {
        const interpreter = `${root}/interpreter?data=${encodeURIComponent("[out:json];node(id:1);out;")}`;
        const q = await fetch(interpreter, { signal: AbortSignal.timeout(1e4) });
        if (q.ok || q.status === 400 || q.status === 429) {
          return { ok: true, detail: `reachable (interpreter HTTP ${q.status})` };
        }
        const rootRes = await fetch(root, { signal: AbortSignal.timeout(5e3) });
        return {
          ok: false,
          detail: `interpreter ${q.status}, root ${rootRes.status}`
        };
      }
      return { ok: false, detail: `overpass responded HTTP ${res.status}` };
    } catch (err) {
      return {
        ok: false,
        detail: `overpass unreachable: ${err instanceof Error ? err.message : String(err)}`
      };
    }
  }
  __name(probeStatus, "probeStatus");
  function indexBody() {
    return {
      name: "supercarto-compile",
      description: "hosted compile of the supercarto maplet pipeline: real map data in, a token-budgeted topological graph out. Same conventions as the local HTTP API in src/server/http.ts.",
      attribution: ATTRIBUTION,
      routes: servedRoutes(),
      unavailable: unavailableBody(),
      fallback: {
        data: "when Overpass refuses this deployment egress (HTTP 521 from every known instance), /maplet and /scr compile from a hosted PMTiles extract of the planet built from OpenStreetMap. The extract detail level is coarse beyond z10-ish, so a city block here is zoom-level honest about what zoom it shipped: the map document carries `source: protomaps` when the fallback served it, and its own truncation warnings when it stopped early.",
        health: "/healthz probes Overpass only; a 503 here does not mean /maplet is down - the PMTiles fallback answers from the archive instead."
      }
    };
  }
  __name(indexBody, "indexBody");
}
__name(createHandler, "createHandler");
async function buildDefaultCarto(opts) {
  const pmtilesUrl = await resolvePmtilesUrl(opts.pmtilesUrl);
  const fallback = new ProtomapsSource({
    url: pmtilesUrl,
    name: "protomaps",
    // See buildDefaultCarto comment: keeps one compile inside a Worker budget.
    maxFeatures: 400
  });
  return new SuperCarto({
    sources: [new OverpassSource(), fallback],
    // Elevation is keyless (Terrarium tiles) and its absence in the hosted
    // surface would silently drop the slope heat layer that answers "can this
    // be wheeled up", for no reason.
    elevation: new TerrariumElevation(
      opts.terrariumEndpoint ? { template: opts.terrariumEndpoint } : {}
    )
    // Weather stays on (Open-Meteo, keyless, the library default).
    // Traffic and transit stay off: traffic always needs a paid credential
    // and transit always needs an operator feed - the library refuses to
    // default either, and this deployment has nothing to add.
  });
}
__name(buildDefaultCarto, "buildDefaultCarto");
var ipCounters = /* @__PURE__ */ new Map();
function rateLimited(req, limitPerMinute) {
  const ip = req.headers.get("cf-connecting-ip") ?? "unknown";
  const now = Date.now();
  if (ipCounters.size > 1e4) {
    for (const [key, entry2] of ipCounters) {
      if (now - entry2.start >= RATE_WINDOW_MS) ipCounters.delete(key);
    }
  }
  let entry = ipCounters.get(ip);
  if (!entry || now - entry.start >= RATE_WINDOW_MS) {
    entry = { start: now, count: 0 };
    ipCounters.set(ip, entry);
  }
  entry.count += 1;
  return entry.count > limitPerMinute ? Math.max(1, Math.ceil((entry.start + RATE_WINDOW_MS - now) / 1e3)) : 0;
}
__name(rateLimited, "rateLimited");
function mapletLimitMessage(limit) {
  return `rate limit: ${limit} maplet requests per minute per IP. This is a best-effort courtesy cap (Workers memory is per isolate, so counts are not global) that protects the shared Overpass instance. Retry after the listed seconds.`;
}
__name(mapletLimitMessage, "mapletLimitMessage");
function json(headers, status, body) {
  return new Response(JSON.stringify(body, null, 2) + "\n", {
    status,
    headers: { ...headers, "content-type": "application/json; charset=utf-8" }
  });
}
__name(json, "json");
function attributionHeaderOn(headers) {
  headers["X-Data-Attribution"] = ATTRIBUTION;
}
__name(attributionHeaderOn, "attributionHeaderOn");
function servedRoutes() {
  return [
    "GET|POST /maplet?lat=&lon=&radiusM=&budget=&layers=&format=yaml|json",
    "GET /scr?bbox=w,s,e,n&layers=",
    "GET /daylight?lat=&lon=&at=",
    "GET /weather?lat=&lon=&hours=",
    "GET /terrain?lat=&lon=&radiusM=&samples=",
    "GET /healthz"
  ];
}
__name(servedRoutes, "servedRoutes");
function unavailableBody() {
  return [
    {
      route: "/transit",
      because: 'a schedule needs an operator-imported GTFS feed read from the local filesystem; a Worker has no filesystem, so transit is absent rather than served as "no service"'
    },
    {
      route: "tool get_traffic",
      because: "live traffic needs a licensed flow provider credential (TomTom or HERE); hosted mode ships none, and free-flow numbers presented as live conditions are the failure this library refuses to make"
    },
    {
      route: "indoor floor plans",
      because: "indoor floor plans are local files: no filesystem here, so indoor layers are absent rather than fabricated"
    }
  ];
}
__name(unavailableBody, "unavailableBody");
function numParam(body, url, key, fallback) {
  const raw = url.searchParams.get(key);
  if (raw === null) {
    const v = body[key];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    return fallback;
  }
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}
__name(numParam, "numParam");
function clamp(v, lo, hi) {
  if (v === void 0) return lo;
  return Math.max(lo, Math.min(hi, v));
}
__name(clamp, "clamp");
function parseBbox(text) {
  if (!text) return void 0;
  const parts = text.split(",").map((s) => Number(s.trim()));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return void 0;
  return normalizeBbox({
    west: parts[0],
    south: parts[1],
    east: parts[2],
    north: parts[3]
  });
}
__name(parseBbox, "parseBbox");
function hasDecodedSamples(grid) {
  if (grid.max !== 0 || grid.min !== 0) return true;
  for (const v of grid.values) {
    if (v !== 0) return true;
  }
  return false;
}
__name(hasDecodedSamples, "hasDecodedSamples");
function formatRadius2(m) {
  return m >= 1e3 ? `${(m / 1e3).toFixed(1)}km` : `${Math.round(m)}m`;
}
__name(formatRadius2, "formatRadius");
var worker_default = {
  fetch(request, env) {
    const overpassEndpoint = env?.OVERPASS_ENDPOINT;
    const terrariumEndpoint = env?.TERRARIUM_ENDPOINT;
    const pmtilesUrl = env?.PMTILES_URL;
    const key = JSON.stringify([overpassEndpoint, terrariumEndpoint, pmtilesUrl]);
    if (handlerKey !== key) {
      handler = createHandler({
        ...overpassEndpoint ? { overpassEndpoint } : {},
        ...terrariumEndpoint ? { terrariumEndpoint } : {},
        ...pmtilesUrl ? { pmtilesUrl } : {}
      });
      handlerKey = key;
    }
    return handler(request);
  }
};
var handler = createHandler();
var handlerKey = "[]";
export {
  createHandler,
  worker_default as default
};
//# sourceMappingURL=worker.js.map
