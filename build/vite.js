import fs from 'node:fs';
import { applicationHtmlPlugin } from './application-html.js';
import cesium from 'vite-plugin-cesium';

/**
 * Opt-in header/HTTPS overrides for embedding this dev server inside another
 * trusted page (e.g. a Jarvis dashboard iframe). Unset by default, which
 * preserves the app's normal `npm run dev` behavior (plain HTTP, blanket
 * `frame-ancestors 'none'`) unchanged. Only set via GEV_FRAME_ANCESTORS /
 * GEV_HTTPS_CERT / GEV_HTTPS_KEY on a dedicated, separately-ported invocation
 * (see package.json's `dev:jarvis` script) — never on the default `dev` entry
 * point, so the standalone instance's clickjacking protection stays intact.
 * @returns {{headers: Record<string,string>, httpsOption: object}}
 */
function frameEmbedOverrides() {
  const frameAncestors = String(process.env.GEV_FRAME_ANCESTORS || '').trim();
  const httpsCert = process.env.GEV_HTTPS_CERT;
  const httpsKey = process.env.GEV_HTTPS_KEY;

  const headers = frameAncestors
    ? { 'Content-Security-Policy': `frame-ancestors 'self' ${frameAncestors}` }
    : {
        'X-Frame-Options': 'DENY',
        'Content-Security-Policy': "frame-ancestors 'none'",
      };

  const httpsOption =
    httpsCert && httpsKey
      ? {
          https: {
            cert: fs.readFileSync(httpsCert),
            key: fs.readFileSync(httpsKey),
          },
        }
      : {};

  return { headers, httpsOption };
}

/** Build browser assets with explicit inputs; never load environment or providers. */
export function createBrowserViteConfig({
  plugins = [],
  publicDir,
  googleApiKey,
  cesiumToken,
  host = 'localhost',
  port = 4173,
} = {}) {
  const { headers, httpsOption } = frameEmbedOverrides();
  return {
    plugins: [cesium(), applicationHtmlPlugin(), ...plugins],
    ...(publicDir === undefined ? {} : { publicDir }),
    server: {
      host: host || 'localhost',
      port: parseInt(port, 10) || 4173,
      allowedHosts:
        host === '0.0.0.0' || host === '::'
          ? true
          : ['localhost', '127.0.0.1', '.local'],
      fs: {
        deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', '**/ENVIRONMENT'],
      },
      // Default: protect the document containing Provider Settings from
      // clickjacking on ANY origin. GEV_FRAME_ANCESTORS opts a specific,
      // separately-ported invocation into a named allowlist instead — see
      // frameEmbedOverrides() above.
      headers,
      ...httpsOption,
    },
    define: {
      'import.meta.env.GOOGLE_MAPS_API_KEY': JSON.stringify(googleApiKey),
      'import.meta.env.CESIUM_ION_TOKEN': JSON.stringify(cesiumToken),
    },
    build: { chunkSizeWarningLimit: 1500 },
  };
}
