/**
 * NS API Portal proxy for the Spoor NL (rail) layer.
 *
 *   GET /api/ns/spoorkaart                              → track segments
 *   GET /api/ns/stations                                → compact station list
 *   GET /api/ns/trips?from=LEDN&to=CAS&dateTime=…&arrival=0|1 → RailOption[]
 *
 * The subscription key stays on the server: it is read through the injected
 * `apiKey()` (the provider passes `process.env.NS_API_KEY`) and is never echoed
 * in a response, a log line or an error. Without a key every route answers 503
 * `ns-key-missing` and the rest of the app is unaffected.
 *
 * Caching: the Spoorkaart keeps 30 days and the station list 7 days, in memory
 * and through the injected disk `store` (the provider writes `.gev-cache/ns/`);
 * a trip query keeps 30 s in memory. When NS fails, a cached Spoorkaart or
 * station list of any age is served rather than nothing. Three upstream
 * failures in a row pause all upstream calls for 30 s.
 *
 * This module stays portable (no Node builtins, no globals beyond fetch): the
 * provider supplies key, store and fetch.
 */

import { normalizeStations } from '../data/railStations.js';
import { normalizeSpoorkaart } from '../data/railGraph.js';
import { parseTrips } from '../data/railTrips.js';

export const NS_GATEWAY = 'https://gateway.apiportal.ns.nl';
export const NS_UPSTREAM_TIMEOUT_MS = 12_000;
export const NS_SPOORKAART_TTL_MS = 30 * 24 * 3600_000;
export const NS_STATIONS_TTL_MS = 7 * 24 * 3600_000;
export const NS_TRIPS_TTL_MS = 30_000;
export const NS_TRIPS_CACHE_MAX = 200;
export const NS_BACKOFF_AFTER_FAILURES = 3;
export const NS_BACKOFF_MS = 30_000;
export const NS_KEY_HINT =
  'Zet NS_API_KEY in .env — zie reference/gods-eye-view-setup.md';

const STATION_CODE = /^(?:[A-Z]{2,6}|\d{7})$/;
const ISO_WITH_OFFSET =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:\d{2})$/;

const JSON_HEADERS = Object.freeze({
  'Content-Type': 'application/json; charset=utf-8',
});

/** Parse and validate a trips query. Returns `{error}` or the upstream params. */
export function parseTripsQuery(searchParams) {
  const from = String(searchParams.get('from') || '')
    .trim()
    .toUpperCase();
  const to = String(searchParams.get('to') || '')
    .trim()
    .toUpperCase();
  if (!STATION_CODE.test(from) || !STATION_CODE.test(to))
    return {
      error: 'Ongeldige stationscode (verwacht bv. LEDN of een UIC-nummer)',
    };
  if (from === to) return { error: 'Vertrek- en aankomststation zijn gelijk' };
  const dateTime = String(searchParams.get('dateTime') || '').trim();
  if (dateTime && !ISO_WITH_OFFSET.test(dateTime))
    return {
      error:
        'Ongeldige dateTime (verwacht ISO met offset, bv. 2026-10-03T08:30:00+02:00)',
    };
  if (dateTime && !Number.isFinite(Date.parse(dateTime)))
    return { error: 'Ongeldige dateTime' };
  const arrival = ['1', 'true'].includes(String(searchParams.get('arrival')));
  return { from, to, dateTime: dateTime || null, arrival };
}

/** Upstream URL for a validated trips query. */
export function nsTripsUrl({ from, to, dateTime, arrival }) {
  const url = new URL('/reisinformatie-api/api/v3/trips', NS_GATEWAY);
  url.searchParams.set(
    /^\d+$/.test(from) ? 'originUicCode' : 'fromStation',
    from,
  );
  url.searchParams.set(
    /^\d+$/.test(to) ? 'destinationUicCode' : 'toStation',
    to,
  );
  if (dateTime) url.searchParams.set('dateTime', dateTime);
  if (arrival) url.searchParams.set('searchForArrival', 'true');
  return url.toString();
}

/**
 * @param {{fetchImpl?: typeof fetch, apiKey?: () => string,
 *   store?: {read: (name: string) => Promise<object|null>, write: (name: string, value: object) => Promise<void>},
 *   now?: () => number, log?: (message: string) => void}} [options]
 * @returns {{handle: (request: {url: string, method: string}) => Promise<Response>, close: () => void}}
 */
export function createNsService({
  fetchImpl = fetch,
  apiKey = () => '',
  store = null,
  now = () => Date.now(),
  log = (message) => console.warn(message),
} = {}) {
  let closed = false;
  let failures = 0;
  let pausedUntil = 0;
  const controllers = new Set();
  /** @type {Map<string, {at:number, body:string}>} */
  const memory = new Map();
  const inFlight = new Map();

  const reply = (status, body, extra = {}) =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { ...JSON_HEADERS, 'Cache-Control': 'no-store', ...extra },
    });

  const key = () => String(apiKey() || '').trim();

  class UpstreamError extends Error {
    constructor(message, status) {
      super(message);
      this.status = status;
    }
  }

  async function upstreamJson(url) {
    if (now() < pausedUntil)
      throw new UpstreamError(
        'NS tijdelijk gepauzeerd na herhaalde fouten',
        503,
      );
    const controller = new AbortController();
    controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), NS_UPSTREAM_TIMEOUT_MS);
    try {
      const response = await fetchImpl(url, {
        signal: controller.signal,
        headers: {
          'Ocp-Apim-Subscription-Key': key(),
          Accept: 'application/json',
        },
      });
      if (!response.ok) {
        try {
          await response.body?.cancel();
        } catch {
          /* no-op */
        }
        if (response.status === 401 || response.status === 403)
          throw new UpstreamError('NS weigert de key (401/403)', 502);
        if (response.status === 429)
          throw new UpstreamError('NS-quotum bereikt (429)', 429);
        throw new UpstreamError(`NS antwoordde HTTP ${response.status}`, 502);
      }
      const json = await response.json();
      failures = 0;
      return json;
    } catch (error) {
      failures += 1;
      if (failures >= NS_BACKOFF_AFTER_FAILURES) {
        pausedUntil = now() + NS_BACKOFF_MS;
        failures = 0;
      }
      if (error instanceof UpstreamError) throw error;
      if (error?.name === 'AbortError')
        throw new UpstreamError('NS reageerde niet binnen 12 s', 504);
      throw new UpstreamError('NS onbereikbaar', 502);
    } finally {
      clearTimeout(timer);
      controllers.delete(controller);
    }
  }

  function single(name, task) {
    if (inFlight.has(name)) return inFlight.get(name);
    const promise = task().finally(() => inFlight.delete(name));
    inFlight.set(name, promise);
    return promise;
  }

  async function readStore(name) {
    if (!store) return null;
    try {
      const value = await store.read(name);
      return value &&
        Number.isFinite(value.at) &&
        typeof value.body === 'string'
        ? value
        : null;
    } catch {
      return null;
    }
  }

  /** Long-lived dataset: memory → disk → NS, with stale fallback on failure. */
  async function dataset(name, ttlMs, url, transform) {
    const t = now();
    let cached = memory.get(name) || null;
    if (!cached) {
      cached = await readStore(name);
      if (cached) memory.set(name, cached);
    }
    if (cached && t - cached.at <= ttlMs)
      return { entry: cached, cache: 'HIT' };
    try {
      const entry = await single(name, async () => {
        const json = await upstreamJson(url);
        const data = transform(json);
        const fresh = {
          at: now(),
          body: JSON.stringify({ fetchedAt: now(), ...data }),
        };
        memory.set(name, fresh);
        if (store) {
          try {
            await store.write(name, fresh);
          } catch (error) {
            log(
              `[ns-proxy] cache write ${name} failed: ${error?.message || error}`,
            );
          }
        }
        return fresh;
      });
      return { entry, cache: 'MISS' };
    } catch (error) {
      if (cached) {
        log(`[ns-proxy] ${name}: ${error.message} — serving cached copy`);
        return { entry: cached, cache: 'STALE-ERROR' };
      }
      throw error;
    }
  }

  async function trips(searchParams) {
    const query = parseTripsQuery(searchParams);
    if (query.error)
      return reply(400, { error: 'bad-request', message: query.error });
    const cacheKey = `trips:${query.from}:${query.to}:${query.dateTime || 'now'}:${query.arrival ? 1 : 0}`;
    const t = now();
    const cached = memory.get(cacheKey);
    if (cached && t - cached.at <= NS_TRIPS_TTL_MS)
      return reply(200, cached.body, { 'X-GEV-Cache': 'HIT' });
    const entry = await single(cacheKey, async () => {
      const json = await upstreamJson(nsTripsUrl(query));
      const fresh = {
        at: now(),
        body: JSON.stringify({
          fetchedAt: now(),
          query: {
            from: query.from,
            to: query.to,
            dateTime: query.dateTime,
            arrival: query.arrival,
          },
          options: parseTrips(json),
        }),
      };
      memory.set(cacheKey, fresh);
      // Trip entries are small but unbounded by query; drop the oldest.
      const tripKeys = [...memory.keys()].filter((k) => k.startsWith('trips:'));
      for (const stale of tripKeys.slice(
        0,
        Math.max(0, tripKeys.length - NS_TRIPS_CACHE_MAX),
      ))
        memory.delete(stale);
      return fresh;
    });
    return reply(200, entry.body, { 'X-GEV-Cache': 'MISS' });
  }

  async function handle(incoming) {
    const url = new URL(incoming.url);
    if (closed) return reply(503, { error: 'ns-closed' });
    if (incoming.method !== 'GET')
      return reply(405, { error: 'Method Not Allowed' });
    const route = url.pathname.replace(/^\/api\/ns/, '').replace(/\/+$/, '');
    if (!['/spoorkaart', '/stations', '/trips'].includes(route))
      return reply(404, { error: 'unknown-route' });
    if (!key())
      return reply(503, { error: 'ns-key-missing', hint: NS_KEY_HINT });
    try {
      if (route === '/trips') return await trips(url.searchParams);
      if (route === '/stations') {
        const { entry, cache } = await dataset(
          'stations',
          NS_STATIONS_TTL_MS,
          `${NS_GATEWAY}/reisinformatie-api/api/v2/stations`,
          (json) => ({ stations: normalizeStations(json) }),
        );
        return reply(200, entry.body, {
          'X-GEV-Cache': cache,
          'Cache-Control': 'public, max-age=3600',
        });
      }
      const { entry, cache } = await dataset(
        'spoorkaart',
        NS_SPOORKAART_TTL_MS,
        `${NS_GATEWAY}/Spoorkaart-API/api/v1/spoorkaart`,
        (json) => ({ segments: normalizeSpoorkaart(json) }),
      );
      return reply(200, entry.body, {
        'X-GEV-Cache': cache,
        'Cache-Control': 'public, max-age=86400',
      });
    } catch (error) {
      const status = Number.isInteger(error?.status) ? error.status : 502;
      log(`[ns-proxy] ${route}: ${error?.message || 'error'}`);
      return reply(
        status,
        {
          error:
            status === 429
              ? 'ns-rate-limited'
              : status === 504
                ? 'ns-timeout'
                : 'ns-upstream',
          message: error?.message || 'NS onbereikbaar',
        },
        status === 429 || status === 503 ? { 'Retry-After': '30' } : {},
      );
    }
  }

  function close() {
    closed = true;
    for (const controller of controllers) controller.abort();
    controllers.clear();
    memory.clear();
  }

  return { handle, close };
}
