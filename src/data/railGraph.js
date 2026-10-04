/**
 * @module railGraph
 * @description Route a train leg along the real track using the NS Spoorkaart.
 *
 * The Spoorkaart is ~760 track segments, each a LineString between two network
 * nodes (`from`/`to`: lower-case station codes, plus junctions that are not
 * passenger stations). A trip gives the stations a leg calls at; between each
 * consecutive pair this module finds the shortest path over the network and
 * stitches the segment geometry together.
 *
 * Why not the NS `traject` endpoint: it was tested on 2026-10-04 and returns an
 * empty LineString for LEDN,HLM,CAS and only the first ~20 points for a full
 * stop list, so it cannot draw a route. A pair that cannot be routed is left
 * out and reported — never bridged with a straight line posing as track.
 */

const EARTH_RADIUS_M = 6_371_008.8;

/** Great-circle distance in metres between two [lon, lat] points. */
export function haversineM(a, b) {
  const toRad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * toRad;
  const dLon = (b[0] - a[0]) * toRad;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a[1] * toRad) * Math.cos(b[1] * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(s)));
}

/**
 * Compact the Spoorkaart GeoJSON into `{from, to, coords}` segments.
 * @param {object} raw NS response (`{payload: FeatureCollection}`) or the collection.
 * @returns {Array<{from:string, to:string, coords:number[][]}>}
 */
export function normalizeSpoorkaart(raw) {
  const features = raw?.payload?.features || raw?.features;
  if (!Array.isArray(features)) return [];
  const out = [];
  for (const feature of features) {
    const from = String(feature?.properties?.from || '').toLowerCase();
    const to = String(feature?.properties?.to || '').toLowerCase();
    const coords = feature?.geometry?.coordinates;
    if (!from || !to || feature?.geometry?.type !== 'LineString') continue;
    if (!Array.isArray(coords) || coords.length < 2) continue;
    out.push({
      from,
      to,
      coords: coords.map(([lon, lat]) => [
        Math.round(lon * 1e5) / 1e5,
        Math.round(lat * 1e5) / 1e5,
      ]),
    });
  }
  return out;
}

/**
 * Build an undirected adjacency graph over the segments.
 * @param {Array<{from:string, to:string, coords:number[][]}>} segments
 * @returns {{segments: Array, adjacency: Map<string, Array<{node:string, seg:number, reversed:boolean, length:number}>>}}
 */
export function buildRailGraph(segments) {
  const adjacency = new Map();
  const add = (node, edge) => {
    let list = adjacency.get(node);
    if (!list) adjacency.set(node, (list = []));
    list.push(edge);
  };
  segments.forEach((segment, seg) => {
    let length = 0;
    for (let i = 1; i < segment.coords.length; i += 1) {
      length += haversineM(segment.coords[i - 1], segment.coords[i]);
    }
    add(segment.from, { node: segment.to, seg, reversed: false, length });
    add(segment.to, { node: segment.from, seg, reversed: true, length });
  });
  return { segments, adjacency };
}

/**
 * Shortest path between two network nodes (Dijkstra over track length).
 * @returns {Array<{seg:number, reversed:boolean}>|null} null when unreachable.
 */
export function shortestRailPath(graph, fromCode, toCode) {
  const from = String(fromCode || '').toLowerCase();
  const to = String(toCode || '').toLowerCase();
  if (!graph.adjacency.has(from) || !graph.adjacency.has(to)) return null;
  if (from === to) return [];
  const dist = new Map([[from, 0]]);
  const prev = new Map();
  const done = new Set();
  // The network is a few hundred nodes; a linear scan of the frontier is
  // simpler than a heap and still well under a millisecond per pair.
  const frontier = new Set([from]);
  while (frontier.size) {
    let current = null;
    let best = Infinity;
    for (const node of frontier) {
      const d = dist.get(node);
      if (d < best) {
        best = d;
        current = node;
      }
    }
    frontier.delete(current);
    if (current === to) break;
    done.add(current);
    for (const edge of graph.adjacency.get(current) || []) {
      if (done.has(edge.node)) continue;
      const next = best + edge.length;
      if (next < (dist.get(edge.node) ?? Infinity)) {
        dist.set(edge.node, next);
        prev.set(edge.node, {
          node: current,
          seg: edge.seg,
          reversed: edge.reversed,
        });
        frontier.add(edge.node);
      }
    }
  }
  if (!prev.has(to)) return null;
  const path = [];
  for (let node = to; node !== from;) {
    const step = prev.get(node);
    path.push({ seg: step.seg, reversed: step.reversed });
    node = step.node;
  }
  return path.reverse();
}

/** Concatenate the coordinates of a path, dropping duplicated joints. */
export function railPathCoordinates(graph, path) {
  const coords = [];
  for (const step of path) {
    const segment = graph.segments[step.seg].coords;
    const ordered = step.reversed ? [...segment].reverse() : segment;
    for (const point of ordered) {
      const last = coords[coords.length - 1];
      if (last && last[0] === point[0] && last[1] === point[1]) continue;
      coords.push(point);
    }
  }
  return coords;
}

/**
 * Geometry for one leg: route every consecutive pair of station codes along
 * the network. Each routable run becomes its own polyline; a gap is reported
 * in `missing` and is never drawn.
 * @param {object} graph From buildRailGraph.
 * @param {string[]} codes Station codes in calling order.
 * @returns {{lines: number[][][], missing: Array<[string, string]>}}
 */
export function routeRailLeg(graph, codes) {
  const lines = [];
  const missing = [];
  let current = [];
  const flush = () => {
    if (current.length >= 2) lines.push(current);
    current = [];
  };
  const clean = (codes || [])
    .filter(Boolean)
    .map((c) => String(c).toLowerCase());
  for (let i = 0; i + 1 < clean.length; i += 1) {
    const path = shortestRailPath(graph, clean[i], clean[i + 1]);
    if (!path || path.length === 0) {
      if (!path) {
        missing.push([clean[i].toUpperCase(), clean[i + 1].toUpperCase()]);
        flush();
      }
      continue;
    }
    const coords = railPathCoordinates(graph, path);
    if (current.length) {
      const last = current[current.length - 1];
      const first = coords[0];
      if (last[0] === first[0] && last[1] === first[1]) coords.shift();
    }
    current.push(...coords);
  }
  flush();
  return { lines, missing };
}

/** Bounding box [west, south, east, north] over lines, or null. */
export function railLinesBounds(lines) {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const line of lines || []) {
    for (const [lon, lat] of line) {
      if (lon < west) west = lon;
      if (lon > east) east = lon;
      if (lat < south) south = lat;
      if (lat > north) north = lat;
    }
  }
  return Number.isFinite(west) ? [west, south, east, north] : null;
}
