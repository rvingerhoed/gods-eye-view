/**
 * @module railTrips
 * @description Pure helpers that turn an NS Reisinformatie API v3 `/trips`
 * response into a compact `RailOption` model and format it for the planner.
 *
 * The proxy parses server-side, so the browser receives a few KB instead of
 * the ~75 KB NS response (fares, notes and presentation hints are dropped).
 */

/** NS writes offsets as `+0200`; normalize to ISO `+02:00`. */
export function normalizeNsDateTime(value) {
  if (typeof value !== 'string' || !value) return null;
  return value.replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
}

function timeMs(value) {
  const ms = Date.parse(normalizeNsDateTime(value) || '');
  return Number.isFinite(ms) ? ms : null;
}

function delayMinutes(planned, actual) {
  const p = timeMs(planned);
  const a = timeMs(actual);
  if (p === null || a === null) return 0;
  return Math.round((a - p) / 60_000);
}

function parseEndpoint(raw) {
  const planned = normalizeNsDateTime(raw?.plannedDateTime);
  const actual = normalizeNsDateTime(raw?.actualDateTime) || planned;
  const plannedTrack = raw?.plannedTrack ? String(raw.plannedTrack) : null;
  const track = raw?.actualTrack ? String(raw.actualTrack) : plannedTrack;
  return {
    name: String(raw?.name || ''),
    code: raw?.stationCode ? String(raw.stationCode).toUpperCase() : null,
    uic: raw?.uicCode ? String(raw.uicCode) : null,
    lat: Number.isFinite(raw?.lat) ? raw.lat : null,
    lon: Number.isFinite(raw?.lng) ? raw.lng : null,
    planned,
    actual,
    delayMin: delayMinutes(planned, actual),
    plannedTrack,
    track,
  };
}

function parseLeg(raw, index) {
  const product = raw?.product || {};
  const walking = raw?.travelType && raw.travelType !== 'PUBLIC_TRANSIT';
  const stops = Array.isArray(raw?.stops)
    ? raw.stops
        .filter((stop) => !stop?.passing)
        .map((stop) => ({
          uic: stop?.uicCode ? String(stop.uicCode) : null,
          name: String(stop?.name || ''),
          lat: Number.isFinite(stop?.lat) ? stop.lat : null,
          lon: Number.isFinite(stop?.lng) ? stop.lng : null,
          cancelled: Boolean(stop?.cancelled),
        }))
    : [];
  return {
    idx: index,
    walking: Boolean(walking),
    product: walking
      ? 'LOPEN'
      : String(product.shortCategoryName || product.categoryCode || 'TREIN'),
    productLong: walking
      ? 'Lopen'
      : String(product.longCategoryName || product.displayName || ''),
    number: product.number ? String(product.number) : null,
    operator: product.operatorName ? String(product.operatorName) : null,
    direction: raw?.direction ? String(raw.direction) : null,
    cancelled: Boolean(raw?.cancelled),
    partCancelled: Boolean(raw?.partCancelled),
    crossPlatform: Boolean(raw?.crossPlatformTransfer),
    from: parseEndpoint(raw?.origin),
    to: parseEndpoint(raw?.destination),
    stops,
  };
}

/** Transfers between consecutive legs: station, minutes and tracks. */
export function transfersBetween(legs) {
  const out = [];
  for (let i = 0; i + 1 < legs.length; i += 1) {
    const arrive = legs[i].to;
    const depart = legs[i + 1].from;
    const a = timeMs(arrive.actual || arrive.planned);
    const d = timeMs(depart.actual || depart.planned);
    out.push({
      station: arrive.name,
      code: arrive.code,
      minutes: a !== null && d !== null ? Math.round((d - a) / 60_000) : null,
      fromTrack: arrive.track,
      toTrack: depart.track,
      crossPlatform: legs[i + 1].crossPlatform,
      lat: arrive.lat,
      lon: arrive.lon,
    });
  }
  return out;
}

/**
 * Parse NS `/trips` JSON into RailOption records.
 * @param {object} json Raw NS response.
 * @returns {Array<object>}
 */
export function parseTrips(json) {
  const trips = Array.isArray(json?.trips) ? json.trips : [];
  return trips
    .filter((trip) => Array.isArray(trip?.legs) && trip.legs.length > 0)
    .map((trip, index) => {
      const legs = trip.legs.map(parseLeg);
      const first = legs[0];
      const last = legs[legs.length - 1];
      const status = String(trip.status || 'NORMAL');
      return {
        idx: Number.isInteger(trip.idx) ? trip.idx : index,
        status,
        cancelled:
          status === 'CANCELLED' ||
          status === 'NOT_POSSIBLE' ||
          legs.some((leg) => leg.cancelled),
        optimal: Boolean(trip.optimal),
        transfers: Number.isInteger(trip.transfers)
          ? trip.transfers
          : Math.max(0, legs.filter((l) => !l.walking).length - 1),
        plannedDurationMin: trip.plannedDurationInMinutes ?? null,
        durationMin:
          trip.actualDurationInMinutes ?? trip.plannedDurationInMinutes ?? null,
        crowd: trip.crowdForecast ? String(trip.crowdForecast) : null,
        departure: first.from,
        arrival: last.to,
        legs,
        transfersDetail: transfersBetween(legs),
      };
    });
}

/** "08:38" from an ISO timestamp (the wall time NS already gives in NL time). */
export function hhmm(iso) {
  const match = /T(\d{2}:\d{2})/.exec(String(iso || ''));
  return match ? match[1] : '--:--';
}

/** "47 min" / "1 u 05". */
export function formatDuration(minutes) {
  if (!Number.isFinite(minutes)) return '?';
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = String(minutes % 60).padStart(2, '0');
  return `${h} u ${m}`;
}

/** "+3" for a delay, '' when on time. */
export function formatDelay(minutes) {
  return Number.isFinite(minutes) && minutes > 0 ? `+${minutes}` : '';
}

/** Whether the track an endpoint actually uses differs from the plan. */
export function trackChanged(endpoint) {
  return Boolean(
    endpoint?.plannedTrack &&
    endpoint?.track &&
    endpoint.plannedTrack !== endpoint.track,
  );
}

/** "direct" / "1× overstap" / "2× overstap". */
export function formatTransfers(count) {
  return count > 0 ? `${count}× overstap` : 'direct';
}

/** "08:38 → 09:25 · 47 min · direct". */
export function formatOptionSummary(option) {
  const dep = hhmm(option.departure.planned);
  const arr = hhmm(option.arrival.planned);
  const depDelay = formatDelay(option.departure.delayMin);
  const arrDelay = formatDelay(option.arrival.delayMin);
  return (
    `${dep}${depDelay ? ` ${depDelay}` : ''} → ${arr}${arrDelay ? ` ${arrDelay}` : ''}` +
    ` · ${formatDuration(option.durationMin)} · ${formatTransfers(option.transfers)}`
  );
}

/** "IC richting Alkmaar · spoor 5b → 1". */
export function formatLeg(leg) {
  if (leg.walking) return `Lopen naar ${leg.to.name}`;
  const dir = leg.direction ? ` richting ${leg.direction}` : '';
  const from = leg.from.track ? `spoor ${leg.from.track}` : 'spoor ?';
  const to = leg.to.track || '?';
  return `${leg.product}${dir} · ${from} → ${to}`;
}

/** "Haarlem · 7 min · spoor 1 → 8". */
export function formatTransferLabel(transfer) {
  const minutes = Number.isFinite(transfer.minutes)
    ? ` · ${transfer.minutes} min`
    : '';
  const tracks =
    transfer.fromTrack || transfer.toTrack
      ? ` · spoor ${transfer.fromTrack || '?'} → ${transfer.toTrack || '?'}`
      : '';
  const same = transfer.crossPlatform ? ' (zelfde perron)' : '';
  return `${transfer.station}${minutes}${tracks}${same}`;
}

/** Index of the option to select first: the optimal one that runs, else the first that runs. */
export function defaultOptionIndex(options) {
  if (!options?.length) return -1;
  const optimal = options.findIndex((o) => o.optimal && !o.cancelled);
  if (optimal >= 0) return optimal;
  const running = options.findIndex((o) => !o.cancelled);
  return running >= 0 ? running : 0;
}
