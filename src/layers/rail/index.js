/**
 * @module layers/rail
 * @description Spoor NL: the Dutch rail network, its stations, and an NS
 * journey planner whose options are drawn along the real track.
 *
 * Data comes from the same-origin `/api/ns/*` proxy (NS API Portal; the key
 * never leaves the server). On first enable the layer loads the Spoorkaart
 * (track segments) and the station list once, drapes the network on terrain
 * and 3D tiles, and puts the stations on top — the major ones visible at
 * national zoom, the rest below ~25 km. The planner panel asks for trips; each
 * option is routed over the Spoorkaart graph (`railGraph.js`), the selected
 * one bright with per-leg colours and transfer labels, the others dimmed.
 * A stretch that cannot be routed is left out and named — never a straight
 * line pretending to be track.
 */

import * as Cesium from 'cesium';
import {
  indexStationsByCode,
  indexStationsByUic,
  isInNlArea,
  isMajorStation,
  searchStations,
  amsterdamWallTimeToIso,
} from '../../data/railStations.js';
import {
  buildRailGraph,
  railLinesBounds,
  routeRailLeg,
} from '../../data/railGraph.js';
import {
  defaultOptionIndex,
  formatOptionSummary,
  formatTransferLabel,
  hhmm,
} from '../../data/railTrips.js';
import {
  RAIL_LEG_COLORS,
  createRailPlannerPanel,
  createRailStationPopup,
} from './plannerPanel.js';

export const RAIL_LAYER_ID = 'rail';
const SOURCE = 'NS';
const NETWORK_COLOR =
  Cesium.Color.fromCssColorString('#ffb347').withAlpha(0.62);
const DIM_COLOR = Cesium.Color.fromCssColorString('#7fdcff').withAlpha(0.3);
const STATION_COLOR = Cesium.Color.fromCssColorString('#fff4e0');
const STATION_OUTLINE = Cesium.Color.fromCssColorString('#ff9f1c');
const LABEL_FILL = Cesium.Color.fromCssColorString('#ffe7c2');
const START_COLOR = Cesium.Color.fromCssColorString('#5dff9f');
const END_COLOR = Cesium.Color.fromCssColorString('#ff6b6b');
const TRANSFER_COLOR = Cesium.Color.fromCssColorString('#ff4fd8');
/** Height above the ellipsoid for station sprites: NL lies ~43 m above it (geoid). */
const SPRITE_HEIGHT_M = 55;
/** Minor stations appear below this camera distance (m). */
const MINOR_STATION_RANGE_M = 25_000;
const MAJOR_LABEL_RANGE_M = 350_000;
const MINOR_LABEL_RANGE_M = 14_000;
const REQUEST_TIMEOUT_MS = 20_000;
/** Keep the frame loop running while ground primitives build, at most this long. */
const BUILD_HOLD_MAX_MS = 15_000;

/** Plain-language text for a proxy error body. Pure. */
export function railErrorMessage(status, body) {
  const code = body?.error;
  if (code === 'ns-key-missing')
    return 'NS_API_KEY ontbreekt — zie reference/gods-eye-view-setup.md';
  if (code === 'ns-rate-limited')
    return 'NS-quotum bereikt — probeer het zo opnieuw';
  if (code === 'ns-timeout') return 'NS reageert niet — probeer het zo opnieuw';
  if (code === 'bad-request') return body?.message || 'Ongeldige aanvraag';
  if (body?.message) return body.message;
  return `NS onbereikbaar (HTTP ${status})`;
}

/** Station codes a leg calls at, in order (UIC → code via the station index). Pure. */
export function legStationCodes(leg, byUic) {
  const codes = leg.stops.map((stop) => byUic.get(stop.uic)?.code || null);
  if (codes.length) {
    if (!codes[0] && leg.from.code) codes[0] = leg.from.code;
    if (!codes[codes.length - 1] && leg.to.code)
      codes[codes.length - 1] = leg.to.code;
    return codes;
  }
  return [leg.from.code, leg.to.code];
}

/** Row descriptor (chips + option list). Pure. */
export function railRowControls(state) {
  const { panelVisible, options, selected, loadState, planning } = state;
  const chips = [
    {
      id: 'planner',
      label: 'PLANNER',
      active: panelVisible,
      state: panelVisible ? 'active' : 'idle',
      title: panelVisible ? 'Reisplanner verbergen' : 'Reisplanner openen',
      params: { panel: !panelVisible },
      disabled: loadState === 'error',
    },
    {
      id: 'fly',
      label: 'FLY',
      disabled: selected < 0 || planning,
      state: 'idle',
      title: 'Camera naar de gekozen reis',
      params: { fly: true },
    },
    {
      id: 'clear',
      label: 'WISSEN',
      disabled: options.length === 0,
      state: 'idle',
      title: 'Reisopties van de kaart halen',
      params: { clear: true },
    },
  ];
  return {
    chips,
    legend: [],
    list: {
      ariaLabel: 'Reisopties',
      items: options.map((option, index) => ({
        id: `opt-${index}`,
        lead: hhmm(option.departure.planned),
        text: `${formatOptionSummary(option)}${option.cancelled ? ' · UITGEVALLEN' : ''}`,
        active: index === selected,
        params: { select: index },
      })),
    },
  };
}

/** Row stats. Pure. */
export function railStats(state) {
  const {
    loadState,
    loadError,
    stationCount,
    segmentCount,
    planning,
    planError,
    options,
    selected,
    lastUpdate,
  } = state;
  if (loadState === 'loading')
    return {
      count: 0,
      loading: true,
      loadingLabel: 'Spoorkaart en stations laden…',
      source: SOURCE,
      error: null,
    };
  if (loadState === 'error')
    return {
      count: 0,
      lastUpdate,
      error: loadError,
      status: 'empty',
      source: SOURCE,
    };
  if (planning)
    return {
      count: stationCount,
      countLabel: `${stationCount} stations`,
      loading: true,
      loadingLabel: 'Reisadvies ophalen…',
      source: SOURCE,
      error: null,
    };
  if (planError)
    return {
      count: stationCount,
      countLabel: `${stationCount} stations`,
      lastUpdate,
      error: planError,
      source: SOURCE,
    };
  const summary =
    selected >= 0 && options[selected]
      ? formatOptionSummary(options[selected])
      : loadState === 'ready'
        ? `${segmentCount} spoortrajecten · open PLANNER voor een reis`
        : 'Spoornet en stations · PLANNER voor reisadvies';
  return {
    count: stationCount,
    countLabel: `${stationCount} stations`,
    lastUpdate,
    error: null,
    source: SOURCE,
    coverage: summary,
    loadingLabel: summary,
  };
}

/**
 * @param {{services: {render: object, sprites: object, picking: object, input: object},
 *   fetchImpl?: typeof fetch, documentRef?: Document}} options
 */
export function createRailLayer({ services, fetchImpl, documentRef } = {}) {
  const doFetch = (...args) => (fetchImpl || globalThis.fetch)(...args);
  const doc = documentRef || globalThis.document;

  let _viewer = null;
  let _enabled = false;
  let _loadState = 'idle';
  let _loadError = null;
  let _loadPromise = null;
  let _stations = [];
  let _byCode = new Map();
  let _byUic = new Map();
  let _graph = null;
  let _lastUpdate = null;

  let _networkPrim = null;
  let _stationPoints = null;
  let _stationLabels = null;
  let _routeDimPrim = null;
  let _routeSelPrim = null;
  let _routePoints = null;
  let _routeLabels = null;
  let _groundSupported = null;

  let _options = [];
  let _geometry = [];
  let _selected = -1;
  let _planning = false;
  let _planError = null;
  let _planSeq = 0;

  let _panel = null;
  let _popup = null;
  let _clickHandler = null;
  let _rowListener = null;
  let _shellSeams = null;
  let _holdTimer = null;
  let _holding = false;

  /** NL stations plus the foreign ones that sit on the NS Spoorkaart. */
  const shownStation = (station) =>
    station.country === 'NL' ||
    (isInNlArea(station) &&
      Boolean(_graph?.adjacency.has(station.code.toLowerCase())));

  const state = () => ({
    panelVisible: Boolean(_panel?.isVisible()),
    options: _options,
    selected: _selected,
    loadState: _loadState,
    loadError: _loadError,
    stationCount: _stations.filter(shownStation).length,
    segmentCount: _graph?.segments.length || 0,
    planning: _planning,
    planError: _planError,
    lastUpdate: _lastUpdate,
  });

  const notifyRow = () => {
    try {
      _rowListener?.();
    } catch {
      /* the panel re-renders on its own schedule */
    }
  };
  const requestRender = (reason) =>
    services.render.governorRequestRender(`rail-${reason}`);

  // ── Render hold while asynchronous ground primitives build ──────────────
  function holdUntilBuilt() {
    if (!_holding) {
      services.render.holdContinuousRender('rail-build');
      _holding = true;
    }
    const started = Date.now();
    clearInterval(_holdTimer);
    _holdTimer = setInterval(() => {
      const prims = [_networkPrim, _routeDimPrim, _routeSelPrim].filter(
        Boolean,
      );
      const built = prims.every((p) => p.isDestroyed?.() || p.ready !== false);
      if (built || Date.now() - started > BUILD_HOLD_MAX_MS) releaseHold();
    }, 200);
  }
  function releaseHold() {
    clearInterval(_holdTimer);
    _holdTimer = null;
    if (_holding) {
      services.render.releaseContinuousRender('rail-build');
      _holding = false;
      requestRender('built');
    }
  }

  function groundSupported() {
    if (_groundSupported === null && _viewer)
      _groundSupported = Cesium.GroundPolylinePrimitive.isSupported(
        _viewer.scene,
      );
    return Boolean(_groundSupported);
  }

  function polylineInstance(coords, width, color, id) {
    const flat = [];
    for (const [lon, lat] of coords) flat.push(lon, lat);
    return new Cesium.GeometryInstance({
      id,
      geometry: new Cesium.GroundPolylineGeometry({
        positions: Cesium.Cartesian3.fromDegreesArray(flat),
        width,
      }),
      attributes: {
        color: Cesium.ColorGeometryInstanceAttribute.fromColor(color),
      },
    });
  }

  function groundPrimitive(instances) {
    return new Cesium.GroundPolylinePrimitive({
      geometryInstances: instances,
      classificationType: Cesium.ClassificationType.BOTH,
      appearance: new Cesium.PolylineColorAppearance(),
    });
  }

  function removeGround(prim) {
    if (prim && _viewer && !_viewer.isDestroyed?.())
      _viewer.scene.groundPrimitives.remove(prim);
    return null;
  }

  // ── Data ────────────────────────────────────────────────────────────────
  async function getJson(path) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await doFetch(path, { signal: controller.signal });
      let body = null;
      try {
        body = await response.json();
      } catch {
        body = null;
      }
      if (!response.ok) {
        const error = new Error(railErrorMessage(response.status, body));
        error.status = response.status;
        throw error;
      }
      return body;
    } catch (error) {
      if (error?.name === 'AbortError')
        throw new Error('NS-proxy reageert niet (time-out)');
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  function ensureLoaded() {
    if (_loadPromise) return _loadPromise;
    _loadState = 'loading';
    _loadError = null;
    notifyRow();
    _loadPromise = Promise.all([
      getJson('/api/ns/stations'),
      getJson('/api/ns/spoorkaart'),
    ])
      .then(([stationBody, kaartBody]) => {
        _stations = Array.isArray(stationBody?.stations)
          ? stationBody.stations
          : [];
        _byCode = indexStationsByCode(_stations);
        _byUic = indexStationsByUic(_stations);
        _graph = buildRailGraph(
          Array.isArray(kaartBody?.segments) ? kaartBody.segments : [],
        );
        _loadState = 'ready';
        _lastUpdate = Date.now();
        if (_viewer) {
          drawNetwork();
          drawStations();
        }
        _panel?.restoreStations(_byCode);
        _panel?.setStatus(
          '',
          _enabled ? 'Kies VAN en NAAR, of klik een station op de kaart.' : '',
        );
        console.log(
          `[Data:Rail] ${_graph.segments.length} track segments, ${_stations.length} stations`,
        );
      })
      .catch((error) => {
        _loadState = 'error';
        _loadError = error?.message || 'Spoorkaart laden mislukt';
        _loadPromise = null; // a later enable may retry
        _panel?.setStatus('error', _loadError);
        console.warn('[Data:Rail] load failed:', _loadError);
      })
      .finally(() => {
        notifyRow();
        requestRender('loaded');
      });
    return _loadPromise;
  }

  // ── Network + stations ──────────────────────────────────────────────────
  function drawNetwork() {
    _networkPrim = removeGround(_networkPrim);
    if (!_graph?.segments.length) return;
    if (!groundSupported()) {
      console.warn(
        '[Data:Rail] GroundPolylinePrimitive unsupported — network hidden',
      );
      return;
    }
    const instances = _graph.segments.map((segment, i) =>
      polylineInstance(segment.coords, 2.2, NETWORK_COLOR, `rail:track:${i}`),
    );
    _networkPrim = _viewer.scene.groundPrimitives.add(
      groundPrimitive(instances),
    );
    _networkPrim.show = _enabled;
    holdUntilBuilt();
  }

  function drawStations() {
    _stationPoints.removeAll();
    _stationLabels.removeAll();
    for (const station of _stations) {
      if (!shownStation(station)) continue;
      const major = isMajorStation(station);
      const position = Cesium.Cartesian3.fromDegrees(
        station.lon,
        station.lat,
        SPRITE_HEIGHT_M,
      );
      _stationPoints.add({
        id: `rail:station:${station.code}`,
        position,
        pixelSize: major ? 7 : 5,
        color: STATION_COLOR,
        outlineColor: STATION_OUTLINE,
        outlineWidth: 1.5,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        distanceDisplayCondition: new Cesium.DistanceDisplayCondition(
          0,
          major ? 4_000_000 : MINOR_STATION_RANGE_M,
        ),
      });
      _stationLabels.add({
        id: `rail:station:${station.code}`,
        position,
        text: major ? station.name : station.medium || station.name,
        font: major ? '600 12px sans-serif' : '11px sans-serif',
        fillColor: LABEL_FILL,
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 3,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        pixelOffset: new Cesium.Cartesian2(0, -10),
        horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
        verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        distanceDisplayCondition: new Cesium.DistanceDisplayCondition(
          0,
          major ? MAJOR_LABEL_RANGE_M : MINOR_LABEL_RANGE_M,
        ),
      });
    }
    requestRender('stations');
  }

  // ── Route ───────────────────────────────────────────────────────────────
  function computeGeometry(options) {
    return options.map((option) => {
      const legs = option.legs.map((leg) =>
        leg.walking
          ? { lines: [], missing: [] }
          : routeRailLeg(_graph, legStationCodes(leg, _byUic)),
      );
      const missing = legs.flatMap((leg) => leg.missing);
      return { legs, missing };
    });
  }

  function clearRouteGraphics() {
    _routeDimPrim = removeGround(_routeDimPrim);
    _routeSelPrim = removeGround(_routeSelPrim);
    _routePoints?.removeAll();
    _routeLabels?.removeAll();
  }

  function routeLabel(text, lon, lat, color) {
    _routeLabels.add({
      position: Cesium.Cartesian3.fromDegrees(lon, lat, SPRITE_HEIGHT_M),
      text,
      font: '600 13px sans-serif',
      fillColor: Cesium.Color.WHITE,
      showBackground: true,
      backgroundColor: new Cesium.Color(0.02, 0.06, 0.09, 0.82),
      backgroundPadding: new Cesium.Cartesian2(6, 4),
      pixelOffset: new Cesium.Cartesian2(12, -14),
      horizontalOrigin: Cesium.HorizontalOrigin.LEFT,
      verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
      outlineColor: color,
    });
  }

  function routeMarker(lon, lat, color, id) {
    _routePoints.add({
      id,
      position: Cesium.Cartesian3.fromDegrees(lon, lat, SPRITE_HEIGHT_M),
      pixelSize: 12,
      color: Cesium.Color.WHITE,
      outlineColor: color,
      outlineWidth: 3,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    });
  }

  function drawRoutes() {
    clearRouteGraphics();
    if (!_viewer || !_options.length) {
      requestRender('route-clear');
      return;
    }
    if (groundSupported()) {
      const dim = [];
      _geometry.forEach((geo, index) => {
        if (index === _selected) return;
        for (const leg of geo.legs)
          for (const line of leg.lines)
            dim.push(
              polylineInstance(line, 4, DIM_COLOR, `rail:option:${index}`),
            );
      });
      if (dim.length)
        _routeDimPrim = _viewer.scene.groundPrimitives.add(
          groundPrimitive(dim),
        );
      const selected = [];
      const geo = _geometry[_selected];
      geo?.legs.forEach((leg, i) => {
        const color = Cesium.Color.fromCssColorString(
          RAIL_LEG_COLORS[i % RAIL_LEG_COLORS.length],
        );
        for (const line of leg.lines)
          selected.push(
            polylineInstance(line, 7, color, `rail:option:${_selected}`),
          );
      });
      if (selected.length)
        _routeSelPrim = _viewer.scene.groundPrimitives.add(
          groundPrimitive(selected),
        );
      holdUntilBuilt();
    }
    const option = _options[_selected];
    if (option) {
      const dep = option.departure;
      const arr = option.arrival;
      if (Number.isFinite(dep.lon)) {
        routeMarker(dep.lon, dep.lat, START_COLOR, `rail:option:${_selected}`);
        routeLabel(
          `${dep.name} · ${hhmm(dep.planned)} · spoor ${dep.track || '?'}`,
          dep.lon,
          dep.lat,
          START_COLOR,
        );
      }
      for (const transfer of option.transfersDetail) {
        if (!Number.isFinite(transfer.lon)) continue;
        routeMarker(
          transfer.lon,
          transfer.lat,
          TRANSFER_COLOR,
          `rail:option:${_selected}`,
        );
        routeLabel(
          formatTransferLabel(transfer),
          transfer.lon,
          transfer.lat,
          TRANSFER_COLOR,
        );
      }
      if (Number.isFinite(arr.lon)) {
        routeMarker(arr.lon, arr.lat, END_COLOR, `rail:option:${_selected}`);
        routeLabel(
          `${arr.name} · ${hhmm(arr.planned)} · spoor ${arr.track || '?'}`,
          arr.lon,
          arr.lat,
          END_COLOR,
        );
      }
    }
    requestRender('route');
  }

  function routeNotes() {
    const notes = new Map();
    _geometry.forEach((geo, index) => {
      if (!geo.missing.length) return;
      notes.set(
        index,
        `Niet op de spoorkaart: ${geo.missing.map(([a, b]) => `${a}–${b}`).join(', ')} (dat stuk is niet getekend)`,
      );
    });
    return notes;
  }

  function flySelected() {
    const geo = _geometry[_selected];
    const option = _options[_selected];
    if (!_viewer || !geo || !option) return false;
    let bounds = railLinesBounds(geo.legs.flatMap((leg) => leg.lines));
    if (
      !bounds &&
      Number.isFinite(option.departure.lon) &&
      Number.isFinite(option.arrival.lon)
    ) {
      bounds = [
        Math.min(option.departure.lon, option.arrival.lon),
        Math.min(option.departure.lat, option.arrival.lat),
        Math.max(option.departure.lon, option.arrival.lon),
        Math.max(option.departure.lat, option.arrival.lat),
      ];
    }
    if (!bounds) return false;
    const [w, s, e, n] = bounds;
    const padX = Math.max(0.02, (e - w) * 0.2);
    const padY = Math.max(0.02, (n - s) * 0.2);
    const destination = Cesium.Rectangle.fromDegrees(
      w - padX,
      s - padY,
      e + padX,
      n + padY,
    );
    const navigate = () => {
      _viewer.camera.flyTo({ destination, duration: 1.6 });
      return true;
    };
    const run = _shellSeams?.runNavigation;
    return typeof run === 'function' ? Boolean(run(navigate)) : navigate();
  }

  function select(index, { fly = true } = {}) {
    if (!Number.isInteger(index) || index < 0 || index >= _options.length)
      return;
    _selected = index;
    drawRoutes();
    _panel?.setSelected(index);
    if (fly) flySelected();
    notifyRow();
  }

  function clearTrips() {
    _planSeq += 1;
    _options = [];
    _geometry = [];
    _selected = -1;
    _planning = false;
    _planError = null;
    clearRouteGraphics();
    _panel?.setOptions([], -1);
    _panel?.setBusy(false);
    _panel?.setStatus('', '');
    notifyRow();
    requestRender('clear');
  }

  async function plan({ from, to, wall, arrival }) {
    const seq = ++_planSeq;
    _planning = true;
    _planError = null;
    _panel?.setBusy(true);
    _panel?.setStatus('busy', `Reisadvies ${from.name} → ${to.name}…`);
    notifyRow();
    try {
      await ensureLoaded();
      if (_loadState !== 'ready')
        throw new Error(_loadError || 'Spoorkaart niet geladen');
      const dateTime = wall ? amsterdamWallTimeToIso(wall) : null;
      const params = new URLSearchParams({
        from: from.code,
        to: to.code,
        arrival: arrival ? '1' : '0',
      });
      if (dateTime) params.set('dateTime', dateTime);
      const body = await getJson(`/api/ns/trips?${params}`);
      if (seq !== _planSeq) return;
      _options = Array.isArray(body?.options) ? body.options : [];
      _geometry = computeGeometry(_options);
      _selected = defaultOptionIndex(_options);
      _lastUpdate = Date.now();
      _panel?.setOptions(_options, _selected, routeNotes());
      _panel?.setStatus(
        '',
        _options.length
          ? `${_options.length} opties ${arrival ? 'met aankomst rond' : 'vanaf'} ${hhmm(dateTime || '')} — klik een optie voor details`
          : 'Geen reisopties gevonden voor dit tijdstip.',
      );
      drawRoutes();
      if (_selected >= 0) flySelected();
    } catch (error) {
      if (seq !== _planSeq) return;
      _planError = error?.message || 'Reisadvies mislukt';
      _panel?.setStatus('error', _planError);
    } finally {
      if (seq === _planSeq) {
        _planning = false;
        _panel?.setBusy(false);
        notifyRow();
      }
    }
  }

  // ── UI ──────────────────────────────────────────────────────────────────
  function ensurePanel() {
    if (_panel || !doc?.body) return _panel;
    _panel = createRailPlannerPanel({
      documentRef: doc,
      search: (q) => searchStations(_stations.filter(shownStation), q, 8),
      onPlan: (q) => void plan(q),
      onSelect: (index) => select(index),
      onClear: clearTrips,
      onVisibility: () => notifyRow(),
    });
    _popup = createRailStationPopup({
      documentRef: doc,
      onChoose: (which, station) => {
        showPanel(true);
        _panel?.setStation(which, station);
      },
    });
    return _panel;
  }

  function showPanel(visible) {
    if (visible) {
      ensurePanel()?.mount();
      if (_loadState === 'ready') _panel?.restoreStations(_byCode);
      if (_loadState === 'error') _panel?.setStatus('error', _loadError);
    } else _panel?.setVisible(false);
    notifyRow();
  }

  function idFromPick(picked) {
    const id = services.picking.resolvePickId
      ? services.picking.resolvePickId(picked)
      : (picked?.id ?? picked?.primitive?.id);
    return typeof id === 'string' ? id : null;
  }

  function installClickHandler() {
    if (_clickHandler || !_viewer) return;
    _clickHandler = new Cesium.ScreenSpaceEventHandler(_viewer.scene.canvas);
    _clickHandler.setInputAction((click) => {
      if (!_enabled || !services.input.isPointerFree()) return;
      let picked = null;
      try {
        picked = _viewer.scene.pick(click.position);
      } catch {
        picked = null;
      }
      const id = idFromPick(picked);
      if (!id?.startsWith('rail:')) return;
      const station = /^rail:station:(.+)$/.exec(id);
      if (station) {
        const record = _byCode.get(station[1]);
        if (!record) return;
        ensurePanel();
        const rect = _viewer.scene.canvas.getBoundingClientRect();
        _popup?.show(
          record,
          rect.left + click.position.x,
          rect.top + click.position.y,
        );
        return;
      }
      const option = /^rail:option:(\d+)$/.exec(id);
      if (option) select(Number(option[1]), { fly: false });
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  }

  function removeClickHandler() {
    _clickHandler?.destroy();
    _clickHandler = null;
    _popup?.hide();
  }

  function setGraphicsVisible(visible) {
    if (_networkPrim) _networkPrim.show = visible;
    if (_stationPoints) _stationPoints.show = visible;
    if (_stationLabels) _stationLabels.show = visible;
    if (_routePoints) _routePoints.show = visible;
    if (_routeLabels) _routeLabels.show = visible;
    if (_routeDimPrim) _routeDimPrim.show = visible;
    if (_routeSelPrim) _routeSelPrim.show = visible;
  }

  // ── Layer module ────────────────────────────────────────────────────────
  return {
    id: RAIL_LAYER_ID,
    name: 'Spoor NL',
    icon: '🚆',
    source: SOURCE,
    updateInterval: 0,

    init(viewer) {
      _viewer = viewer;
      _stationPoints = viewer.scene.primitives.add(
        new Cesium.PointPrimitiveCollection({
          blendOption: Cesium.BlendOption.TRANSLUCENT,
        }),
      );
      _stationLabels = viewer.scene.primitives.add(
        new Cesium.LabelCollection(),
      );
      _routePoints = viewer.scene.primitives.add(
        new Cesium.PointPrimitiveCollection({
          blendOption: Cesium.BlendOption.TRANSLUCENT,
        }),
      );
      _routeLabels = viewer.scene.primitives.add(new Cesium.LabelCollection());
      services.sprites.registerSpriteCollection('rail', _stationPoints);
      services.sprites.registerSpriteCollection('rail-route', _routePoints);
      setGraphicsVisible(false);
      services.sprites.restoreSpriteOrder(viewer);
      console.log('[Data:Rail] Initialized');
    },

    enable(viewer) {
      _enabled = true;
      setGraphicsVisible(true);
      services.picking.registerPickOwner(
        RAIL_LAYER_ID,
        (id) => typeof id === 'string' && id.startsWith('rail:'),
      );
      installClickHandler();
      services.sprites.restoreSpriteOrder(viewer);
      void ensureLoaded();
      requestRender('enable');
    },

    disable(viewer) {
      _enabled = false;
      setGraphicsVisible(false);
      removeClickHandler();
      _panel?.setVisible(false);
      services.picking.unregisterPickOwner(RAIL_LAYER_ID);
      releaseHold();
      requestRender('disable');
      void viewer;
    },

    async update() {},

    setParams(params = {}) {
      if (!params || typeof params !== 'object') return false;
      if (params.clear) clearTrips();
      if (params.panel !== undefined) showPanel(Boolean(params.panel));
      if (params.select !== undefined) select(Number(params.select));
      if (params.fly) flySelected();
      notifyRow();
      return true;
    },

    getParams() {
      return {};
    },

    getRowControls() {
      return railRowControls(state());
    },

    setRowControlsListener(listener) {
      _rowListener = typeof listener === 'function' ? listener : null;
    },

    getStats() {
      return railStats(state());
    },

    attachShellServices(seams) {
      _shellSeams = seams || null;
    },

    destroy(viewer) {
      if (_enabled) this.disable(viewer);
      releaseHold();
      _planSeq += 1;
      _networkPrim = removeGround(_networkPrim);
      clearRouteGraphics();
      for (const [key, collection] of [
        ['rail', _stationPoints],
        ['rail-route', _routePoints],
      ]) {
        if (collection)
          services.sprites.unregisterSpriteCollection(key, collection);
      }
      for (const collection of [
        _stationPoints,
        _stationLabels,
        _routePoints,
        _routeLabels,
      ]) {
        if (collection && viewer?.scene?.primitives)
          viewer.scene.primitives.remove(collection);
      }
      _stationPoints = _stationLabels = _routePoints = _routeLabels = null;
      _panel?.destroy();
      _panel = null;
      _popup?.destroy();
      _popup = null;
      _rowListener = null;
      _shellSeams = null;
      _viewer = null;
    },
  };
}
