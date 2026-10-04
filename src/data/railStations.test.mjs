import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  amsterdamDateTime,
  amsterdamOffsetMinutes,
  amsterdamWallTimeToIso,
  amsterdamWallValue,
  foldStationText,
  indexStationsByUic,
  isInNlArea,
  isMajorStation,
  normalizeStations,
  resolveStation,
  searchStations,
} from './railStations.js';

const stations = normalizeStations(
  JSON.parse(readFileSync(new URL('./fixtures/ns/stations-sample.json', import.meta.url), 'utf8')),
);

test('normalizes the NS v2 payload into compact records', () => {
  const leiden = stations.find((s) => s.code === 'LEDN');
  assert.deepEqual(
    { ...leiden, synonyms: undefined },
    {
      code: 'LEDN',
      uic: '8400390',
      name: 'Leiden Centraal',
      medium: leiden.medium,
      short: leiden.short,
      synonyms: undefined,
      lat: leiden.lat,
      lon: leiden.lon,
      type: leiden.type,
      country: 'NL',
    },
  );
  assert.ok(Math.abs(leiden.lat - 52.166) < 0.01);
  assert.ok(isMajorStation(leiden));
  assert.equal(normalizeStations({ payload: [{ code: 'X', lat: 'n/a' }] }).length, 0);
  assert.equal(normalizeStations(null).length, 0);
});

test('indexes by UIC for trip stops', () => {
  const byUic = indexStationsByUic(stations);
  assert.equal(byUic.get('8400151').code, 'CAS');
  assert.equal(byUic.get('8400390').code, 'LEDN');
});

test('folds accents, apostrophes and punctuation', () => {
  assert.equal(foldStationText("'s-Hertogenbosch"), 's hertogenbosch');
  assert.equal(foldStationText('Zürich HB'), 'zurich hb');
  assert.equal(foldStationText('  DEN   Haag '), 'den haag');
});

test('searches by code, name prefix, word prefix and synonym', () => {
  assert.equal(searchStations(stations, 'cas')[0].code, 'CAS');
  assert.equal(searchStations(stations, 'LEIDEN')[0].code, 'LEDN');
  assert.equal(searchStations(stations, 'leiden c')[0].code, 'LEDN');
  const haag = searchStations(stations, 'den haag');
  assert.equal(haag[0].code, 'GVC', 'the hub ranks first');
  assert.ok(haag.some((s) => s.code === 'GV'));
  assert.equal(searchStations(stations, "'s-Gravenhage")[0].code, 'GVC');
  assert.equal(searchStations(stations, 'centraal', 2).length, 2);
  assert.deepEqual(searchStations(stations, ''), []);
  assert.deepEqual(searchStations(stations, 'xyzxyz'), []);
  assert.equal(resolveStation(stations, 'haarlem').code, 'HLM');
});

test('NL area check keeps Dutch stations', () => {
  assert.ok(isInNlArea(stations.find((s) => s.code === 'MT')));
});

test('Amsterdam offset follows summer and winter time', () => {
  assert.equal(amsterdamOffsetMinutes(Date.parse('2026-07-01T12:00:00Z')), 120);
  assert.equal(amsterdamOffsetMinutes(Date.parse('2026-12-01T12:00:00Z')), 60);
});

test('instant → Amsterdam ISO with explicit offset', () => {
  assert.equal(amsterdamDateTime(Date.parse('2026-10-03T06:30:00Z')), '2026-10-03T08:30:00+02:00');
  assert.equal(amsterdamDateTime(new Date('2026-11-03T07:30:00Z')), '2026-11-03T08:30:00+01:00');
  assert.equal(amsterdamDateTime('not a date'), null);
  assert.equal(amsterdamWallValue(Date.parse('2026-10-03T06:30:00Z')), '2026-10-03T08:30');
});

test('wall time → ISO around the October 2026 clock change', () => {
  assert.equal(amsterdamWallTimeToIso('2026-10-24T08:30'), '2026-10-24T08:30:00+02:00');
  assert.equal(amsterdamWallTimeToIso('2026-10-25T01:30'), '2026-10-25T01:30:00+02:00');
  // 02:30 happens twice on 25-10-2026; the first (summer time) is taken.
  assert.equal(amsterdamWallTimeToIso('2026-10-25T02:30'), '2026-10-25T02:30:00+02:00');
  assert.equal(amsterdamWallTimeToIso('2026-10-25T03:30'), '2026-10-25T03:30:00+01:00');
  assert.equal(amsterdamWallTimeToIso('2026-10-26T08:30'), '2026-10-26T08:30:00+01:00');
});

test('wall time inside the March gap moves forward an hour', () => {
  assert.equal(amsterdamWallTimeToIso('2027-03-28T02:30'), '2027-03-28T03:30:00+02:00');
  assert.equal(amsterdamWallTimeToIso('garbage'), null);
});
