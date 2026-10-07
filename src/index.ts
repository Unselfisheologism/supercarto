import { createRequire } from 'node:module';
/**
 * supercarto — LLM-native spatial middleware.
 *
 * Two formats, deliberately separate:
 *   - SCR, a compact wire format for machines and networks.
 *   - A topological YAML graph, which is what a language model actually reads.
 *
 * The agent never sees SCR. See `docs/spec.md` and `docs/reasoning-format.md`.
 */

// --- Pipeline: the one-call path -------------------------------------------
export { toMaplet, fromScr, filterLayers } from './pipeline.js';
export type { MapletRequest, MapletResult } from './pipeline.js';

// --- Wire format ------------------------------------------------------------
export { encodeDocument, encode } from './wire/encode.js';
export { decodeDocument, decode } from './wire/decode.js';
export { ScrError } from './wire/errors.js';
export {
  encodePath,
  encodeDeltaPath,
  encodePolygon,
  decodePath,
  decodeDeltaPath,
  decodePathAuto,
  decodePolygon,
  encodePathSmart,
  signedRingArea,
  PART_SEPARATOR,
} from './wire/geometry.js';
export * from './wire/types.js';

// --- Ingestion --------------------------------------------------------------
export { fromGeoJson, KEY_IDS as INGEST_KEY_IDS } from './ingest/geojson.js';
export type {
  GeoJsonFeature,
  GeoJsonFeatureCollection,
  GeoJsonGeometry,
  IngestOptions,
} from './ingest/geojson.js';

// --- Compilation ------------------------------------------------------------
export { compile, propsOf, resolveProp } from './compile/compiler.js';
export type { CompileOptions } from './compile/compiler.js';
export type {
  SpatialGraph,
  GraphNode,
  GraphEdge,
  GraphMeta,
  HeatSummary,
  Obstacle,
  NodeKind,
} from './compile/graph.js';

// --- Indoor topology ---------------------------------------------------------
export {
  buildIndoorGraph,
  emptyIndoor,
  isMeaningfulIndoor,
  levelLabel,
  type IndoorGraph,
  type IndoorLevel,
  type IndoorNode,
  type IndoorEdge,
  type IndoorFeature,
  type VerticalLink,
  type VerticalKind,
  type Storey,
} from './compile/indoor.js';

// --- Emission ---------------------------------------------------------------
export { emitGraph, estimateTokens, yamlString } from './emit/yaml.js';
export type { EmitOptions, EmitResult } from './emit/yaml.js';

// --- Budgeting --------------------------------------------------------------
export {
  fitToBudget,
  contractAnonymousChains,
  estimateGraphTokens,
  scoreNode,
} from './budget/budget.js';
export type { BudgetOptions, BudgetResult } from './budget/budget.js';

// --- Geodesy ----------------------------------------------------------------
export {
  gridToLonLat,
  lonLatToGrid,
  tileBounds,
  lonLatToTile,
  bboxToTile,
  haversine,
  gridDistance,
  metersPerDegLon,
  latToMercY,
  lonToMercX,
  mercXToLon,
  mercYToLat,
  mercEnvelope,
  MERCATOR_MAX_LAT,
} from './geo/project.js';
export {
  simplifyLine,
  dedupeLine,
  weldKey,
  bearing,
  compassOf,
  turnFrom,
  zoomForRadius,
  bboxOfLine,
  bboxIntersects,
  type Bbox,
  type Compass,
} from './geo/geometry.js';
export { gridScaleFor, mercEnvelopeFor, type GridScale } from './geo/scale.js';

// --- Live data sources ------------------------------------------------------
export {
  SuperCarto,
  featuresFromDocument,
  type SuperCartoOptions,
  type MapletRequestLive,
  type LiveResult,
} from './live.js';
export {
  bboxAround,
  normalizeBbox,
  bboxAreaSqm,
  type MapSource,
  type SourceRequest,
  type SourceResult,
  type BboxQuery,
} from './source/types.js';
export { OverpassSource, OVERPASS_ENDPOINT, type OverpassOptions } from './source/overpass.js';
export {
  OsrmRouter,
  straightLineRoute,
  OSRM_PROFILES,
  type RoutingSource,
  type RouteRequest,
  type RouteResult,
  type TravelMode,
  type OsrmOptions,
} from './source/routing.js';
export {
  TerrariumElevation,
  elevationToHeat,
  type ElevationSource,
  type ElevationGrid,
} from './source/terrain.js';

// --- Weather and traffic -----------------------------------------------------
export {
  OpenMeteoWeather,
  describeCode,
  type WeatherSource,
  type WeatherResult,
  type WeatherNow,
  type WeatherHour,
  type WeatherDay,
  type PrecipitationKind,
  type OpenMeteoOptions,
} from './source/weather.js';
export {
  TomTomFlow,
  HereFlow,
  TrafficRouter,
  levelForRatio,
  type TrafficSource,
  type TrafficResult,
  type TrafficRequest,
  type FlowLevel,
  type FlowSegment,
} from './source/traffic.js';

// --- Tiled sources -----------------------------------------------------------
export {
  ProtomapsSource,
  PmtilesArchive,
  PROTOMAPS_DEMO,
  type ProtomapsOptions,
} from './source/protomaps.js';
export { decodeMvt } from './source/mvt.js';
export type { MvtTile, MvtLayer, MvtFeature } from './source/mvt.js';
export { densityToHeat, slopeToHeat } from './source/heat.js';

export {
  evaluateOpeningHours,
  openingPhrase,
  type OpenState,
} from './source/hours.js';

export {
  sunPosition,
  needsLight,
  type SunState,
} from './source/sun.js';

// --- Binary transport -------------------------------------------------------
export {
  encodeBinary,
  decodeBinary,
  ByteWriter,
  ByteReader,
  SCR_BINARY_MAGIC,
} from './binary/codec.js';
export {
  encode as encodeBinaryPacked,
  decode as decodeBinaryPacked,
  isScrBinary,
  defaultCodec,
  mimeFor,
  zstdAvailable,
  type Codec,
} from './binary/compress.js';

// --- Servers ----------------------------------------------------------------
export {
  defineTools,
  assertToolsMatchCatalog,
  type McpTool,
  type ToolResult,
} from './server/mcp.js';
export {
  TOOL_CATALOG,
  advertisedTools,
  allToolNames,
  offersTool,
  type ToolDescriptor,
} from './toolcatalog.js';
export { McpStdioServer, mainMcp, type StdioServerOptions } from './server/stdio.js';
export { MapApiServer, startApiServer, type ApiOptions } from './server/http.js';

// --- Configuration -----------------------------------------------------------
export {
  cartoFromEnv,
  sourcesFor,
  type EnvOverrides,
} from './config.js';

export const VERSION: string = (createRequire(import.meta.url)('../package.json') as { version: string }).version;
