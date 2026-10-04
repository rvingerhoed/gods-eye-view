import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  legStationCodes,
  railErrorMessage,
  railRowControls,
  railStats,
} from './index.js';
import { parseTrips } from '../../data/railTrips.js';
import {
  indexStationsByUic,
  normalizeStations,
} from '../../data/railStations.js';

const fixture = (name) =>
  JSON.parse(
    readFileSync(
      new URL(`../../data/fixtures/ns/${name}`, import.meta.url),
      'utf8',
    ),
  );
const options = parseTrips(fixture('trips-ledn-cas.json'));
const byUic = indexStationsByUic(
  normalizeStations(fixture('stations-sample.json')),
);

test('proxy errors become plain Dutch, the missing key names the setup doc', () => {
  assert.match(
    railErrorMessage(503, { error: 'ns-key-missing' }),
    /NS_API_KEY ontbreekt — zie reference\/gods-eye-view-setup\.md/,
  );
  assert.match(railErrorMessage(429, { error: 'ns-rate-limited' }), /quotum/);
  assert.equal(
    railErrorMessage(400, { error: 'bad-request', message: 'Ongeldig' }),
    'Ongeldig',
  );
  assert.match(railErrorMessage(500, null), /HTTP 500/);
});

test('leg station codes come from the stop UICs, in calling order', () => {
  assert.deepEqual(legStationCodes(options[0].legs[0], byUic), [
    'LEDN',
    'SHL',
    'ASS',
    'CAS',
  ]);
  assert.deepEqual(legStationCodes(options[1].legs[1], byUic), [
    'HLM',
    'BLL',
    'SPTZ',
    'SPTN',
    'DRH',
    'BV',
    'HK',
    'UTG',
    'CAS',
  ]);
  // Unknown UICs at the ends fall back to the leg's own station codes.
  const leg = { ...options[0].legs[0], stops: [{ uic: '1' }, { uic: '2' }] };
  assert.deepEqual(legStationCodes(leg, byUic), ['LEDN', 'CAS']);
});

test('row: planner/fly/clear chips and one list item per option', () => {
  const row = railRowControls({
    panelVisible: false,
    options,
    selected: 1,
    loadState: 'ready',
    planning: false,
  });
  assert.deepEqual(
    row.chips.map((c) => c.id),
    ['planner', 'fly', 'clear'],
  );
  assert.deepEqual(row.chips[0].params, { panel: true });
  assert.equal(row.chips[1].disabled, false);
  assert.equal(row.list.items.length, 2);
  assert.equal(row.list.items[1].active, true);
  assert.deepEqual(row.list.items[0].params, { select: 0 });
  assert.equal(row.list.items[0].lead, '08:38');
  const empty = railRowControls({
    panelVisible: true,
    options: [],
    selected: -1,
    loadState: 'ready',
    planning: false,
  });
  assert.equal(empty.chips[1].disabled, true);
  assert.equal(empty.chips[2].disabled, true);
  assert.deepEqual(empty.chips[0].params, { panel: false });
});

test('stats: loading, key error, ready and selected trip', () => {
  const base = {
    stationCount: 400,
    segmentCount: 763,
    planning: false,
    planError: null,
    options: [],
    selected: -1,
    lastUpdate: 1,
  };
  assert.equal(railStats({ ...base, loadState: 'loading' }).loading, true);
  const failed = railStats({
    ...base,
    loadState: 'error',
    loadError: 'NS_API_KEY ontbreekt',
  });
  assert.equal(failed.error, 'NS_API_KEY ontbreekt');
  assert.equal(failed.count, 0);
  const ready = railStats({ ...base, loadState: 'ready' });
  assert.equal(ready.countLabel, '400 stations');
  assert.match(ready.coverage, /763 spoortrajecten/);
  const chosen = railStats({
    ...base,
    loadState: 'ready',
    options,
    selected: 0,
  });
  assert.equal(chosen.coverage, '08:38 → 09:25 · 47 min · direct');
});
