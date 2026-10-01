import process from 'node:process';
import { OverpassSource } from './source/overpass.js';
import { ProtomapsSource } from './source/protomaps.js';
import { TerrariumElevation } from './source/terrain.js';
import { HereFlow, TomTomFlow } from './source/traffic.js';
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
    overpassFallback: overrides.overpassFallback ?? process.env.SUPERCARTO_OVERPASS_FALLBACK !== '0',
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

  // Traffic is never enabled implicitly. Both providers check for a credential
  // themselves and report `configured: false` without one, so passing them
  // unconditionally costs nothing and means setting one env var is enough.
  options.traffic = [
    env.tomTomKey ? new TomTomFlow({ apiKey: env.tomTomKey }) : new TomTomFlow({ apiKey: '' }),
    env.hereKey ? new HereFlow({ apiKey: env.hereKey }) : new HereFlow({ apiKey: '' }),
  ];

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