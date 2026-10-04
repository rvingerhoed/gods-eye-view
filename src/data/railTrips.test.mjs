import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  defaultOptionIndex,
  formatDelay,
  formatDuration,
  formatLeg,
  formatOptionSummary,
  formatTransferLabel,
  hhmm,
  normalizeNsDateTime,
  parseTrips,
  trackChanged,
} from './railTrips.js';

const raw = () =>
  JSON.parse(readFileSync(new URL('./fixtures/ns/trips-ledn-cas.json', import.meta.url), 'utf8'));

test('normalizes NS offsets to ISO', () => {
  assert.equal(normalizeNsDateTime('2026-10-05T08:38:00+0200'), '2026-10-05T08:38:00+02:00');
  assert.equal(normalizeNsDateTime(null), null);
});

test('a direct trip: times, tracks, product and calling stations', () => {
  const [direct] = parseTrips(raw());
  assert.equal(direct.transfers, 0);
  assert.equal(direct.durationMin, 47);
  assert.equal(direct.cancelled, false);
  assert.equal(direct.legs.length, 1);
  const leg = direct.legs[0];
  assert.equal(leg.product, 'IC');
  assert.equal(leg.direction, 'Alkmaar');
  assert.equal(leg.from.code, 'LEDN');
  assert.equal(leg.from.track, '5b');
  assert.equal(leg.to.code, 'CAS');
  assert.equal(leg.to.track, '1');
  assert.equal(leg.stops[0].uic, '8400390');
  assert.equal(leg.stops.at(-1).uic, '8400151');
  assert.ok(leg.stops.every((s) => Number.isFinite(s.lat) && Number.isFinite(s.lon)));
  assert.equal(formatOptionSummary(direct), '08:38 → 09:25 · 47 min · direct');
  assert.equal(formatLeg(leg), 'IC richting Alkmaar · spoor 5b → 1');
  assert.deepEqual(direct.transfersDetail, []);
});

test('a trip with one transfer: transfer station, minutes and tracks', () => {
  const [, transfer] = parseTrips(raw());
  assert.equal(transfer.transfers, 1);
  assert.equal(transfer.legs.length, 2);
  const detail = transfer.transfersDetail[0];
  assert.equal(detail.station, 'Haarlem');
  assert.equal(detail.minutes, 7);
  assert.equal(detail.fromTrack, '1');
  assert.equal(detail.toTrack, '8');
  assert.equal(formatTransferLabel(detail), 'Haarlem · 7 min · spoor 1 → 8');
  assert.match(formatOptionSummary(transfer), /1× overstap$/);
});

test('a cancelled leg marks the option cancelled and is not the default', () => {
  const json = raw();
  json.trips[0].legs[0].cancelled = true;
  json.trips[0].status = 'CANCELLED';
  const options = parseTrips(json);
  assert.equal(options[0].cancelled, true);
  assert.equal(defaultOptionIndex(options), 1);
});

test('a changed track and a delay are reported', () => {
  const json = raw();
  const origin = json.trips[0].legs[0].origin;
  origin.actualTrack = '8';
  origin.actualDateTime = '2026-10-05T08:41:00+0200';
  const [option] = parseTrips(json);
  assert.equal(option.departure.plannedTrack, '5b');
  assert.equal(option.departure.track, '8');
  assert.ok(trackChanged(option.departure));
  assert.ok(!trackChanged(option.arrival));
  assert.equal(option.departure.delayMin, 3);
  assert.equal(formatOptionSummary(option), '08:38 +3 → 09:25 · 47 min · direct');
});

test('a trip over midnight keeps correct minutes', () => {
  const json = raw();
  const [leg1, leg2] = json.trips[1].legs;
  leg1.destination.plannedDateTime = '2026-10-05T23:58:00+0200';
  leg1.destination.actualDateTime = '2026-10-05T23:58:00+0200';
  leg2.origin.plannedDateTime = '2026-10-06T00:06:00+0200';
  leg2.origin.actualDateTime = '2026-10-06T00:06:00+0200';
  const [, option] = parseTrips(json);
  assert.equal(option.transfersDetail[0].minutes, 8);
  assert.equal(hhmm(option.legs[1].from.planned), '00:06');
});

test('formatting helpers', () => {
  assert.equal(formatDuration(47), '47 min');
  assert.equal(formatDuration(65), '1 u 05');
  assert.equal(formatDuration(undefined), '?');
  assert.equal(formatDelay(0), '');
  assert.equal(formatDelay(4), '+4');
  assert.equal(hhmm('nonsense'), '--:--');
  assert.deepEqual(parseTrips({}), []);
  assert.equal(defaultOptionIndex([]), -1);
});
