/**
 * @module railStations
 * @description Pure station helpers for the Spoor NL (rail) layer.
 *
 * The NS station list (Reisinformatie API v2 `/stations`) is normalized
 * server-side into a compact record, searched client-side for the planner's
 * VAN/NAAR autocomplete, and indexed by UIC code because trip stops carry only
 * a UIC code. Times sent to NS are always Amsterdam wall-clock time with an
 * explicit offset, whatever timezone the browser happens to be in.
 */

/** NS station types from most to least important. */
export const RAIL_STATION_TYPE_RANK = Object.freeze({
  MEGA_STATION: 0,
  KNOOPPUNT_INTERCITY_STATION: 1,
  INTERCITY_STATION: 2,
  KNOOPPUNT_SNELTREIN_STATION: 3,
  SNELTREIN_STATION: 4,
  KNOOPPUNT_STOPTREIN_STATION: 5,
  STOPTREIN_STATION: 6,
  FACULTATIEF_STATION: 7,
});

const UNKNOWN_RANK = 8;

/** Rough box around the Netherlands plus the border stations NS serves. */
export const RAIL_NL_BOUNDS = Object.freeze({
  south: 50.6,
  north: 53.6,
  west: 3.3,
  east: 7.3,
});

/** Rank of a station type (lower = more important). */
export function stationTypeRank(type) {
  return RAIL_STATION_TYPE_RANK[type] ?? UNKNOWN_RANK;
}

/** Whether a station is shown (and labelled) at national zoom. */
export function isMajorStation(station) {
  return stationTypeRank(station?.type) <= 2;
}

/**
 * Normalize the NS v2 station payload into compact records.
 * Accepts the raw response (`{payload: [...]}`) or the bare array.
 * @param {object|Array} raw
 * @returns {Array<{code:string, uic:string, name:string, medium:string,
 *   short:string, synonyms:string[], lat:number, lon:number, type:string,
 *   country:string}>}
 */
export function normalizeStations(raw) {
  const list = Array.isArray(raw) ? raw : raw?.payload;
  if (!Array.isArray(list)) return [];
  const out = [];
  const seen = new Set();
  for (const entry of list) {
    const code = String(entry?.code || '')
      .trim()
      .toUpperCase();
    const lat = Number(entry?.lat);
    const lon = Number(entry?.lng ?? entry?.lon);
    if (!/^[A-Z0-9]{2,8}$/.test(code) || seen.has(code)) continue;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const names = entry?.namen || entry?.names || {};
    const name = String(names.lang || names.long || entry?.name || code);
    seen.add(code);
    out.push({
      code,
      uic: String(entry?.UICCode || entry?.uic || ''),
      name,
      medium: String(names.middel || names.medium || name),
      short: String(names.kort || names.short || name),
      synonyms: Array.isArray(entry?.synoniemen)
        ? entry.synoniemen.map(String)
        : Array.isArray(entry?.synonyms)
          ? entry.synonyms.map(String)
          : [],
      lat: Math.round(lat * 1e5) / 1e5,
      lon: Math.round(lon * 1e5) / 1e5,
      type: String(entry?.stationType || entry?.type || ''),
      country: String(entry?.land || entry?.country || ''),
    });
  }
  return out;
}

/** Whether a station lies in (or just around) the Netherlands. */
export function isInNlArea(station) {
  const b = RAIL_NL_BOUNDS;
  return (
    station.lat >= b.south &&
    station.lat <= b.north &&
    station.lon >= b.west &&
    station.lon <= b.east
  );
}

/** Index station records by UIC code. */
export function indexStationsByUic(stations) {
  const map = new Map();
  for (const station of stations || []) {
    if (station.uic) map.set(station.uic, station);
  }
  return map;
}

/** Index station records by (upper-case) station code. */
export function indexStationsByCode(stations) {
  const map = new Map();
  for (const station of stations || []) map.set(station.code, station);
  return map;
}

/**
 * Fold text for matching: lower case, no accents, no apostrophes, single
 * spaces ("'s-Hertogenbosch" → "s hertogenbosch").
 */
export function foldStationText(text) {
  return String(text ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[’'`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function matchScore(station, q) {
  if (station.code.toLowerCase() === q.replace(/ /g, '')) return 0;
  const names = [station.name, station.medium, station.short].map(
    foldStationText,
  );
  if (names.some((n) => n === q)) return 1;
  if (names.some((n) => n.startsWith(q))) return 2;
  if (names.some((n) => n.split(' ').some((w) => w.startsWith(q)))) return 3;
  const synonyms = station.synonyms.map(foldStationText);
  if (synonyms.some((s) => s.startsWith(q))) return 4;
  if (names.some((n) => n.includes(q))) return 5;
  if (synonyms.some((s) => s.includes(q))) return 6;
  return null;
}

/**
 * Search stations for the autocomplete. Exact code first, then name prefix,
 * word prefix, synonym prefix and substring; ties go to the more important
 * station, then alphabetically.
 * @param {Array<object>} stations Normalized records.
 * @param {string} query Free text ("leiden", "cas", "den haag").
 * @param {number} [limit=8]
 * @returns {Array<object>}
 */
export function searchStations(stations, query, limit = 8) {
  const q = foldStationText(query);
  if (!q) return [];
  const hits = [];
  for (const station of stations || []) {
    const score = matchScore(station, q);
    if (score !== null) hits.push({ station, score });
  }
  hits.sort(
    (a, b) =>
      a.score - b.score ||
      stationTypeRank(a.station.type) - stationTypeRank(b.station.type) ||
      a.station.name.localeCompare(b.station.name, 'nl'),
  );
  return hits.slice(0, Math.max(0, limit)).map((hit) => hit.station);
}

/**
 * Resolve free text to one station: an exact code or name wins, otherwise the
 * best search hit.
 */
export function resolveStation(stations, text) {
  return searchStations(stations, text, 1)[0] || null;
}

const OFFSET_FORMAT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Europe/Amsterdam',
  timeZoneName: 'longOffset',
});
const WALL_FORMAT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Amsterdam',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

/** Amsterdam's UTC offset in minutes at one instant (60 or 120). */
export function amsterdamOffsetMinutes(instantMs) {
  const part = OFFSET_FORMAT.formatToParts(new Date(instantMs)).find(
    (p) => p.type === 'timeZoneName',
  )?.value;
  const match = /GMT([+-])(\d{2}):(\d{2})/.exec(part || '');
  if (!match) return 0;
  const sign = match[1] === '-' ? -1 : 1;
  return sign * (Number(match[2]) * 60 + Number(match[3]));
}

function formatOffset(minutes) {
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  return `${sign}${hh}:${mm}`;
}

/**
 * ISO timestamp with explicit Amsterdam offset for one instant, e.g.
 * `2026-10-03T08:30:00+02:00`.
 * @param {Date|number|string} dateLike
 * @returns {string|null}
 */
export function amsterdamDateTime(dateLike = Date.now()) {
  const ms =
    dateLike instanceof Date ? dateLike.getTime() : Number(new Date(dateLike));
  if (!Number.isFinite(ms)) return null;
  const parts = Object.fromEntries(
    WALL_FORMAT.formatToParts(new Date(ms)).map((p) => [p.type, p.value]),
  );
  const wall = `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
  return wall + formatOffset(amsterdamOffsetMinutes(ms));
}

/**
 * Interpret a `datetime-local` value ("2026-10-25T02:30") as Amsterdam
 * wall-clock time and return it as ISO with offset.
 *
 * Around the clock change: an hour that happens twice (last Sunday of October,
 * 02:00–03:00) resolves to the first, summer-time occurrence; an hour that does
 * not exist (last Sunday of March, 02:00–03:00) moves forward by one hour.
 * @param {string} wall
 * @returns {string|null}
 */
export function amsterdamWallTimeToIso(wall) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(
    String(wall || '').trim(),
  );
  if (!match) return null;
  const [, y, mo, d, h, mi, s = '00'] = match;
  const asUtc = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s);
  if (!Number.isFinite(asUtc)) return null;
  for (const offset of [120, 60]) {
    const instant = asUtc - offset * 60_000;
    if (amsterdamOffsetMinutes(instant) === offset) {
      return amsterdamDateTime(instant);
    }
  }
  // Inside the spring-forward gap: no such wall time; take the instant it
  // would have been on winter time, which reads one hour later.
  return amsterdamDateTime(asUtc - 60 * 60_000);
}

/** `datetime-local` value (Amsterdam wall clock, minutes) for an instant. */
export function amsterdamWallValue(dateLike = Date.now()) {
  const iso = amsterdamDateTime(dateLike);
  return iso ? iso.slice(0, 16) : '';
}
