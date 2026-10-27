import process from 'node:process';
import { OverpassSource } from './source/overpass.js';
import { ProtomapsSource } from './source/protomaps.js';
import { TerrariumElevation } from './source/terrain.js';
import { HereFlow, TomTomFlow } from './source/traffic.js';
import { GtfsSource } from './source/gtfs.js';
import { SuperCarto, type SuperCartoOptions } from './live.js';
import type { MapSource } from './source/types.js';

/**
 * The default configuration, read from the environment.
 *
 * This lives in one place because it previously existed in two - the CLI and
 * the MCP server - and they had already drifted. The CLI grew PMTiles support
 * and the server did not, so `supercarto fetch` and the same call through MCP
 * returned data from different sources with different latencies. An operator
 * has no way to see that, which is exactly the kind of bug that gets reported
 * as "the server is slower than the CLI".
 *
 * Environment variables, all optional:
 *
 *   SUPERCARTO_PMTILES   URL or path to a PMTiles archive. When set it becomes
 *                        the primary source, ahead of Overpass. This is the
 *                        right setting for production: a range request against
 *                        object storage is milliseconds where Overpass is tens
 *                        of seconds.
 *   OVERPASS_ENDPOINT    Your own Overpass instance. Still consulted when
 *                        PMTiles is set, as a fallback.
 *   TERRARIUM_ENDPOINT   Elevation tile template.
 *   TOMTOM_API_KEY       Enables live traffic conditions.
 *   HERE_API_KEY         Same, for HERE as the provider.
 *   SUPERCARTO_GTFS      Path to a GTFS (static transit) feed: a directory of
 *                        .csv/.txt tables or a .zip archive. When set, the
 *                        `get_transit` tool is offered and `/transit` serves
 *                        schedule data. Off by default, see below.
 *   SUPERCARTO_GTFS_RT   URL of the feed's GTFS-Realtime TripUpdates endpoint.
 *                        Requires SUPERCARTO_GTFS. When set, transit answers
 *                        carry live delay lines beside the schedule; when the
 *                        feed cannot be read, the map says so and keeps every
 *                        scheduled fact.
 */

export interface EnvOverrides {
  pmtiles?: string;
  overpass?: string;
  elevation?: string;
  tomTomKey?: string;
  hereKey?: string;
  /** Set to disable elevation entirely. */
  noTerrain?: boolean;
  /** Set to fall back to Overpass even when PMTiles is configured. */
  overpassFallback?: boolean;
  /** Set to disable weather. */
  noWeather?: boolean;
  /** Set to disable air quality. */
  noAir?: boolean;
  /** Path to a GTFS feed directory or .zip. Enables the `get_transit` tool. */
  gtfs?: string;
  /** A GTFS-Realtime TripUpdates URL joined onto the schedule feed. */
  gtfsRt?: string;
}

/** Build a `SuperCarto` from explicit overrides. */
export function cartoFromEnv(overrides: EnvOverrides = {}): SuperCarto {
  const env: EnvOverrides = {
    pmtiles: overrides.pmtiles ?? process.env.SUPERCARTO_PMTILES,
    overpass: overrides.overpass ?? process.env.OVERPASS_ENDPOINT,
    elevation: overrides.elevation ?? process.env.TERRARIUM_ENDPOINT,
    tomTomKey: overrides.tomTomKey ?? process.env.TOMTOM_API_KEY ?? process.env.TRAFFIC_API_KEY,
    hereKey: overrides.hereKey ?? process.env.HERE_API_KEY,
    noTerrain: overrides.noTerrain ?? Boolean(process.env.SUPERCARTO_NO_TERRAIN),
    noWeather: overrides.noWeather ?? Boolean(process.env.SUPERCARTO_NO_WEATHER),
    noAir: overrides.noAir ?? Boolean(process.env.SUPERCARTO_NO_AIR),
    overpassFallback: overrides.overpassFallback ?? process.env.SUPERCARTO_OVERPASS_FALLBACK !== '0',
    gtfs: overrides.gtfs ?? process.env.SUPERCARTO_GTFS,
    gtfsRt: overrides.gtfsRt ?? process.env.SUPERCARTO_GTFS_RT,
  };

  const sources = sourcesFor(env);
  const options: SuperCartoOptions = { sources };

  // Terrain is on by default and the source needs no key, so a bare install
  // gets `get_terrain`. It is a separate service and its failure degrades that
  // one tool rather than the whole server.
  if (!env.noTerrain) {
    options.elevation = new TerrariumElevation(
      env.elevation ? { template: env.elevation } : {},
    );
  }

  // Weather likewise: Open-Meteo needs no credential, so `get_weather` works out
  // of the box and an agent gets correct advice about rain by default.
  if (env.noWeather) {
    options.weather = false;
  }

  // Air is the same story one pollutant further: keyless source, on by
  // default, and `SUPERCARTO_NO_AIR` turns it off as a unit.
  if (env.noAir) {
    options.air = false;
  }

  // Traffic is never enabled implicitly. Both providers check for a credential
  // themselves and report `configured: false` without one, so passing them
  // unconditionally costs nothing and means setting one env var is enough.
  options.traffic = [
    env.tomTomKey ? new TomTomFlow({ apiKey: env.tomTomKey }) : new TomTomFlow({ apiKey: '' }),
    env.hereKey ? new HereFlow({ apiKey: env.hereKey }) : new HereFlow({ apiKey: '' }),
  ];

  // Transit is never enabled implicitly, and for a stronger reason than auth:
  // a schedule is only as fresh as the operator's last feed import. A tool that
  // answers "when is my bus" from last spring's timetable sounds exactly like a
  // live schedule, so serving one must be an explicit operator decision, with
  // the operator owning the freshness. A broken path is not a startup failure
  // either: the source loads lazily, so a configured-but-broken feed surfaces
  // as a clear error on the first query while the rest of the server works.
  options.transit = env.gtfs
    ? new GtfsSource(env.gtfs, env.gtfsRt ? { url: env.gtfsRt } : undefined)
    : undefined;

  return new SuperCarto(options);
}

/**
 * Source list in priority order.
 *
 * PMTiles first when configured, because it is both faster and free of the
 * public-instance rate limit. Overpass remains as a fallback rather than a
 * replacement, so a partial archive or a transient storage failure still yields
 * a map instead of an error.
 */
export function sourcesFor(env: EnvOverrides): MapSource[] {
  const sources: MapSource[] = [];

  if (env.pmtiles) {
    sources.push(new ProtomapsSource({ url: env.pmtiles }));
  }
  if (env.overpassFallback !== false || sources.length === 0) {
    sources.push(new OverpassSource(env.overpass ? { endpoint: env.overpass } : {}));
  }
  return sources;
}