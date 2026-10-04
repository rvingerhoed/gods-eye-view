import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  NS_BACKOFF_MS,
  createNsService,
  nsTripsUrl,
  parseTripsQuery,
} from './nsService.js';

const fixture = (name) =>
  readFileSync(new URL(`../data/fixtures/ns/${name}`, import.meta.url), 'utf8');

const KEY = 'test-key-1234567890abcdef';
const request = (path, method = 'GET') => ({
  url: `http://localhost${path}`,
  method,
});
const jsonResponse = (body, status = 200) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

function memoryStore() {
  const data = new Map();
  return {
    data,
    async read(name) {
      return data.get(name) ?? null;
    },
    async write(name, value) {
      data.set(name, value);
    },
  };
}

test('trips query validation accepts codes, UIC numbers and ISO with offset', () => {
  const ok = parseTripsQuery(
    new URLSearchParams('from=ledn&to=CAS&dateTime=2026-10-03T08:30:00%2B02:00&arrival=1'),
  );
  assert.deepEqual(ok, {
    from: 'LEDN',
    to: 'CAS',
    dateTime: '2026-10-03T08:30:00+02:00',
    arrival: true,
  });
  assert.equal(parseTripsQuery(new URLSearchParams('from=8400390&to=CAS')).from, '8400390');
  for (const bad of [
    'from=LEDN',
    'from=LEDN&to=LEDN',
    'from=LE-DN&to=CAS',
    'from=LEDN&to=CAS&dateTime=2026-10-03T08:30',
    'from=LEDN&to=CAS&dateTime=tomorrow',
    'from=https://evil&to=CAS',
  ]) {
    assert.ok(parseTripsQuery(new URLSearchParams(bad)).error, bad);
  }
});

test('trips upstream URL uses station codes or UIC parameters', () => {
  const url = new URL(
    nsTripsUrl({ from: 'LEDN', to: '8400151', dateTime: '2026-10-03T08:30:00+02:00', arrival: true }),
  );
  assert.equal(url.origin, 'https://gateway.apiportal.ns.nl');
  assert.equal(url.pathname, '/reisinformatie-api/api/v3/trips');
  assert.equal(url.searchParams.get('fromStation'), 'LEDN');
  assert.equal(url.searchParams.get('destinationUicCode'), '8400151');
  assert.equal(url.searchParams.get('dateTime'), '2026-10-03T08:30:00+02:00');
  assert.equal(url.searchParams.get('searchForArrival'), 'true');
});

test('without a key every route answers 503 ns-key-missing and NS is never called', async (t) => {
  let calls = 0;
  const service = createNsService({
    apiKey: () => '',
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse({});
    },
  });
  t.after(service.close);
  for (const path of ['/api/ns/spoorkaart', '/api/ns/stations', '/api/ns/trips?from=LEDN&to=CAS']) {
    const response = await service.handle(request(path));
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.equal(body.error, 'ns-key-missing');
    assert.match(body.hint, /NS_API_KEY/);
  }
  assert.equal(calls, 0);
});

test('unknown routes and non-GET methods are refused', async (t) => {
  const service = createNsService({ apiKey: () => KEY, fetchImpl: async () => jsonResponse({}) });
  t.after(service.close);
  assert.equal((await service.handle(request('/api/ns/traject'))).status, 404);
  assert.equal((await service.handle(request('/api/ns/../../etc'))).status, 404);
  assert.equal((await service.handle(request('/api/ns/stations', 'POST'))).status, 405);
});

test('trips are parsed server-side, sent with the key header, and cached for 30 s', async (t) => {
  let clock = 1_000_000;
  const seen = [];
  const service = createNsService({
    apiKey: () => KEY,
    now: () => clock,
    fetchImpl: async (url, init) => {
      seen.push({ url, key: init.headers['Ocp-Apim-Subscription-Key'] });
      return jsonResponse(fixture('trips-ledn-cas.json'));
    },
  });
  t.after(service.close);
  const path = '/api/ns/trips?from=LEDN&to=CAS&dateTime=2026-10-05T08:30:00%2B02:00';
  const first = await service.handle(request(path));
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('X-GEV-Cache'), 'MISS');
  const body = await first.json();
  assert.equal(body.options.length, 2);
  assert.equal(body.options[1].transfersDetail[0].station, 'Haarlem');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].key, KEY);

  clock += 10_000;
  assert.equal((await service.handle(request(path))).headers.get('X-GEV-Cache'), 'HIT');
  assert.equal(seen.length, 1);
  clock += 25_000;
  assert.equal((await service.handle(request(path))).headers.get('X-GEV-Cache'), 'MISS');
  assert.equal(seen.length, 2);
});

test('an invalid trips query is a 400 before NS is contacted', async (t) => {
  let calls = 0;
  const service = createNsService({
    apiKey: () => KEY,
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse({});
    },
  });
  t.after(service.close);
  const response = await service.handle(request('/api/ns/trips?from=LEDN&to=CAS&dateTime=8:30'));
  assert.equal(response.status, 400);
  assert.equal(calls, 0);
});

test('upstream failures become 502/429 without leaking the key', async (t) => {
  const logs = [];
  let status = 401;
  const service = createNsService({
    apiKey: () => KEY,
    log: (message) => logs.push(message),
    fetchImpl: async () => jsonResponse({ message: `bad key ${KEY}` }, status),
  });
  t.after(service.close);
  const rejected = await service.handle(request('/api/ns/trips?from=LEDN&to=CAS'));
  assert.equal(rejected.status, 502);
  const text = await rejected.text();
  assert.match(text, /weigert de key/);
  assert.ok(!text.includes(KEY));
  status = 429;
  const limited = await service.handle(request('/api/ns/trips?from=LEDN&to=HLM'));
  assert.equal(limited.status, 429);
  assert.equal((await limited.json()).error, 'ns-rate-limited');
  assert.ok(logs.every((line) => !line.includes(KEY)));
});

test('three failures in a row pause upstream calls for 30 s', async (t) => {
  let clock = 5_000_000;
  let calls = 0;
  const service = createNsService({
    apiKey: () => KEY,
    now: () => clock,
    log: () => {},
    fetchImpl: async () => {
      calls += 1;
      throw new TypeError('fetch failed');
    },
  });
  t.after(service.close);
  for (const to of ['CAS', 'HLM', 'ASD']) {
    assert.equal((await service.handle(request(`/api/ns/trips?from=LEDN&to=${to}`))).status, 502);
  }
  assert.equal(calls, 3);
  const paused = await service.handle(request('/api/ns/trips?from=LEDN&to=UT'));
  assert.equal(paused.status, 503);
  assert.equal(calls, 3);
  clock += NS_BACKOFF_MS + 1;
  await service.handle(request('/api/ns/trips?from=LEDN&to=UT'));
  assert.equal(calls, 4);
});

test('stations and spoorkaart are compacted, written to the store, and served stale when NS fails', async (t) => {
  let clock = 9_000_000;
  let fail = false;
  const store = memoryStore();
  const service = createNsService({
    apiKey: () => KEY,
    now: () => clock,
    store,
    log: () => {},
    fetchImpl: async (url) => {
      if (fail) throw new TypeError('fetch failed');
      return jsonResponse(
        fixture(String(url).includes('Spoorkaart') ? 'spoorkaart-sample.json' : 'stations-sample.json'),
      );
    },
  });
  t.after(service.close);
  const stations = await (await service.handle(request('/api/ns/stations'))).json();
  assert.ok(stations.stations.some((s) => s.code === 'LEDN' && s.uic === '8400390'));
  const kaart = await (await service.handle(request('/api/ns/spoorkaart'))).json();
  assert.ok(kaart.segments.length > 10);
  assert.ok(kaart.segments.every((s) => s.from && s.to && s.coords.length >= 2));
  assert.ok(store.data.has('stations') && store.data.has('spoorkaart'));

  // A fresh service (server restart) reads the disk copy without calling NS.
  let restartCalls = 0;
  const restarted = createNsService({
    apiKey: () => KEY,
    now: () => clock,
    store,
    fetchImpl: async () => {
      restartCalls += 1;
      return jsonResponse({});
    },
  });
  t.after(restarted.close);
  const fromDisk = await restarted.handle(request('/api/ns/stations'));
  assert.equal(fromDisk.headers.get('X-GEV-Cache'), 'HIT');
  assert.equal(restartCalls, 0);

  // Past the TTL with NS down: the old copy is served, not an error.
  clock += 31 * 24 * 3600_000;
  fail = true;
  const stale = await service.handle(request('/api/ns/spoorkaart'));
  assert.equal(stale.status, 200);
  assert.equal(stale.headers.get('X-GEV-Cache'), 'STALE-ERROR');
});
