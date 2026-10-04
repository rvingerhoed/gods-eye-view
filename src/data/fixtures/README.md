# Test fixtures

- `tomtom-flow-austin-12-935-1686.pbf` — one real TomTom traffic-flow vector
  tile (Mapbox Vector Tile protobuf, layer `"Traffic flow"`), downtown Austin
  z12 x935 y1686, captured 2026-07-16 from
  `api.tomtom.com/traffic/map/4/tile/flow/relative/12/935/1686.pbf`
  (22,980 bytes). Used by offline decode/source tests and the explicit `qa-traffic --fixtures`
  browser mode — it is a point-in-time congestion snapshot, not a bundled
  data layer, and is never loaded by ordinary application startup. © TomTom.
- `ns/trips-ledn-cas.json` — two real NS Reisinformatie API v3 `/trips`
  options Leiden Centraal → Castricum (a direct Intercity and a Sprinter with
  a transfer at Haarlem), captured 2026-10-04 for 2026-10-05 08:30; fares,
  notes and presentation hints stripped. Used by the rail trip parser and the
  NS proxy tests. © NS (Nederlandse Spoorwegen).
- `ns/stations-sample.json` — 25 stations from the NS v2 `/stations` list
  (the Leiden–Haarlem–Castricum corridor plus a few hubs), facilities
  removed. Used by the station search and UIC-index tests. © NS.
- `ns/spoorkaart-sample.json` — the 24 Spoorkaart track segments those trips
  run over, unchanged GeoJSON from `Spoorkaart-API/api/v1/spoorkaart`. Used by
  the rail-graph routing tests. © NS.
