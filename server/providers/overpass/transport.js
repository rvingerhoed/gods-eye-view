import {
  OVERPASS_MAX_RESPONSE_BYTES,
  OVERPASS_UPSTREAMS,
  OVERPASS_USER_AGENT,
  OVERPASS_TIMEOUT_MS,
  OVERPASS_HEDGE_MS,
} from './constants.js';
import { readResponseTextCapped } from '../common/http.js';
import { simplifyOverpassPayloadBody } from './geometry.js';

/**
 * Detect whether an Overpass API response body indicates rate-limiting.
 *
 * Checks for known rate-limit phrases in the body text regardless of
 * HTTP status code, since some mirrors return 200 with an error payload.
 *
 * @param {string} bodyText - Upstream response body.
 * @returns {boolean} True if the body looks rate-limited.
 */
function overpassLooksRateLimited(bodyText) {
  const text = String(bodyText || '').toLowerCase();
  return (
    text.includes('rate_limited') ||
    text.includes('quota of your ip address') ||
    text.includes('dispatcher_client::request_read_and_idx::rate_limited') ||
    text.includes('too many requests')
  );
}

/**
 * Detect an Overpass HTTP-200 body that is actually a runtime FAILURE (server-side
 * timeout / out-of-memory) via its `remark`. These are transient upstream failures,
 * not authoritative empty results, so they must not be returned or cached.
 */
function overpassLooksRuntimeError(bodyText) {
  const text = String(bodyText || '').toLowerCase();
  return (
    text.includes('runtime error') ||
    text.includes('timed out') ||
    text.includes('out of memory')
  );
}

/**
 * True only for an upstream response that is actually Overpass data.
 *
 * The proxy caches on this and serves stale on its negation, so the two
 * decisions cannot drift apart: a payload that is not data must never be
 * written to the cache and must always be eligible for a stale replacement.
 * @param {{status: number, rateLimited?: boolean, runtimeError?: boolean}} payload
 * @returns {boolean}
 */
function overpassPayloadIsData(payload) {
  const status = Number(payload?.status);
  return (
    Number.isFinite(status) &&
    status >= 200 &&
    status < 300 &&
    !payload.rateLimited &&
    !payload.runtimeError
  );
}

/**
 * Ask each mirror once, retaining response-size and per-mirror timeout caps.
 *
 * Mirrors are started in order but hedged: the next one starts after
 * `hedgeMs`, or immediately when the current one refuses/fails. The first
 * real answer wins and aborts the rest. Strictly sequential rotation used to
 * stack the per-mirror timeouts (two silent mirrors = ~44 s of dead wait
 * before a healthy one was even asked — field test 2026-09-28).
 *
 * Refusals and body-level failures rotate; total failure returns the last
 * rate-limit payload, otherwise the first refusal (in mirror order), or throws
 * the last network error.
 * @param {string} body URL-encoded Overpass QL query body.
 * @param {number} [maxResponseBytes] Endpoint-specific response cap.
 * @param {object} [options] Server-only endpoint and I/O overrides for tests.
 * @returns {Promise<{status:number,body:string,contentType:string,endpoint:string,rateLimited:boolean}>}
 */
function fetchOverpassPayload(
  body,
  maxResponseBytes = OVERPASS_MAX_RESPONSE_BYTES,
  {
    endpoints = OVERPASS_UPSTREAMS,
    fetchImpl = fetch,
    readBody = readResponseTextCapped,
    simplify = simplifyOverpassPayloadBody,
    hedgeMs = OVERPASS_HEDGE_MS,
    timeoutMs = OVERPASS_TIMEOUT_MS,
  } = {},
) {
  let lastError = null;
  let lastRateLimitPayload = null;
  /** @type {Array<object|undefined>} refusal payloads by mirror index. */
  const refusals = [];
  const controllers = [];
  let next = 0;
  let pending = 0;
  let settled = false;
  let hedgeTimer = null;

  /** One mirror; resolves to a data payload, or null when it did not answer. */
  async function attempt(index) {
    const endpoint = endpoints[index];
    const controller = new AbortController();
    controllers.push(controller);
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const upstream = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': OVERPASS_USER_AGENT,
        },
        body,
        signal: controller.signal,
      });

      const responseBody = await readBody(upstream, maxResponseBytes);
      const contentType =
        upstream.headers.get('content-type') || 'application/json';
      const status = upstream.status;
      const rateLimited =
        status === 429 || overpassLooksRateLimited(responseBody);
      const runtimeError = overpassLooksRuntimeError(responseBody);
      const payload = {
        status,
        body: responseBody,
        contentType,
        endpoint,
        rateLimited,
        runtimeError,
      };

      if (rateLimited) {
        lastRateLimitPayload = payload;
        return null;
      }
      // A 200 body carrying a runtime error / timeout is a transient upstream
      // failure — skip to the next mirror rather than returning or caching it.
      if (runtimeError) {
        lastError = new Error(`Overpass runtime error (${endpoint})`);
        return null;
      }
      // Anything but 2xx is this mirror declining, not an answer. Only 5xx used
      // to rotate, so a 4xx ended the fan-out and was returned — and cached —
      // as data: a mirror refusing this client answers 406 while the others
      // answer 200 to the very same request, so every Overpass-backed layer
      // failed on an error page with healthy mirrors untried. The first
      // refusal is kept so a genuinely bad query still reports what upstream
      // said, but only after every mirror has had the chance to answer it.
      if (status < 200 || status >= 300) {
        refusals[index] = payload;
        lastError = new Error(
          `Overpass upstream returned ${status} (${endpoint})`,
        );
        return null;
      }

      // Success: decimate giant boundary geometry before it reaches the cache,
      // the disk, or the client (what makes the 32 MB read cap safe to hold).
      payload.body = simplify(payload.body);
      return payload;
    } catch (error) {
      // A loser aborted by the winner is not a failure worth reporting.
      if (!settled) lastError = error;
      return null;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  return new Promise((resolve, reject) => {
    const finish = (settle) => {
      if (settled) return;
      settled = true;
      clearTimeout(hedgeTimer);
      for (const controller of controllers) controller.abort();
      settle();
    };

    const launchNext = () => {
      clearTimeout(hedgeTimer);
      if (settled || next >= endpoints.length) return;
      const index = next++;
      pending += 1;
      attempt(index).then((payload) => {
        pending -= 1;
        if (settled) return;
        if (payload) {
          finish(() => resolve(payload));
          return;
        }
        if (next < endpoints.length) {
          launchNext(); // this mirror declined — don't wait out the hedge
        } else if (pending === 0) {
          finish(() => {
            if (lastRateLimitPayload) resolve(lastRateLimitPayload);
            else if (refusals.some(Boolean)) resolve(refusals.find(Boolean));
            else reject(lastError || new Error('All Overpass upstreams failed'));
          });
        }
      });
      if (next < endpoints.length) {
        hedgeTimer = setTimeout(launchNext, hedgeMs);
      }
    };

    if (endpoints.length === 0) {
      reject(new Error('All Overpass upstreams failed'));
      return;
    }
    launchNext();
  });
}

export { overpassPayloadIsData, fetchOverpassPayload };
