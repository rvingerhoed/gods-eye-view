import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  buildRailGraph,
  haversineM,
  normalizeSpoorkaart,
  railLinesBounds,
  routeRailLeg,
  shortestRailPath,
} from './railGraph.js';

const segments = normalizeSpoorkaart(
  JSON.parse(readFileSync(new URL('./fixtures/ns/spoorkaart-sample.json', import.meta.url), 'utf8')),
);
const graph = buildRailGraph(segments);

test('normalizes Spoorkaart features into from/to segments', () => {
  assert.ok(segments.length >= 20);
  assert.ok(segments.every((s) => s.from === s.from.toLowerCase() && s.coords.length >= 2));
  assert.deepEqual(normalizeSpoorkaart({ payload: { features: [{ geometry: { type: 'Point' } }] } }), []);
});

test('haversine is roughly right (Leiden → Castricum ≈ 44 km as the crow flies)', () => {
  const d = haversineM([4.4817, 52.1661], [4.6586, 52.5458]);
  assert.ok(d > 43_000 && d < 45_000, String(d));
});

test('routes Leiden → Haarlem along the track, following the line', () => {
  const path = shortestRailPath(graph, 'LEDN', 'HLM');
  assert.ok(path && path.length > 0);
  const { lines, missing } = routeRailLeg(graph, ['LEDN', 'VH', 'HIL', 'HAD', 'HLM']);
  assert.deepEqual(missing, []);
  assert.equal(lines.length, 1);
  const line = lines[0];
  assert.ok(line.length > 50, 'many points, not a straight line');
  // Starts near Leiden and ends near Haarlem.
  assert.ok(haversineM(line[0], [4.4817, 52.1661]) < 1500);
  assert.ok(haversineM(line.at(-1), [4.6362, 52.3878]) < 1500);
  // No point jumps more than a few km: it is a continuous track.
  for (let i = 1; i < line.length; i += 1) assert.ok(haversineM(line[i - 1], line[i]) < 5000);
});

test('an unknown station leaves a gap instead of a straight line', () => {
  const { lines, missing } = routeRailLeg(graph, ['LEDN', 'XXXX', 'HLM']);
  assert.deepEqual(missing, [
    ['LEDN', 'XXXX'],
    ['XXXX', 'HLM'],
  ]);
  assert.equal(lines.length, 0);
  assert.equal(shortestRailPath(graph, 'LEDN', 'NOPE'), null);
  assert.deepEqual(shortestRailPath(graph, 'LEDN', 'ledn'), []);
});

test('bounds over lines', () => {
  assert.deepEqual(railLinesBounds([[[4, 52], [5, 53]], [[3.5, 52.5]]]), [3.5, 52, 5, 53]);
  assert.equal(railLinesBounds([]), null);
});
