import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { createNsService } from '../../src/sources/nsService.js';

/** Disk store for the long-lived NS datasets (`.gev-cache/ns/<name>.json`). */
export function nsDiskStore(
  dir = path.join(process.cwd(), '.gev-cache', 'ns'),
) {
  const file = (name) =>
    path.join(dir, `${name.replace(/[^a-z0-9-]/gi, '_')}.json`);
  return {
    async read(name) {
      try {
        return JSON.parse(await fsp.readFile(file(name), 'utf8'));
      } catch {
        return null;
      }
    },
    async write(name, value) {
      await fsp.mkdir(dir, { recursive: true });
      await fsp.writeFile(file(name), JSON.stringify(value), 'utf8');
    },
  };
}

/** Connect the NS request service (Spoor NL layer) to development and preview. */
export function nsProxy(options = {}) {
  const service = createNsService({
    apiKey: () => process.env.NS_API_KEY || '',
    store: nsDiskStore(),
    ...options,
  });
  function install(server) {
    server.middlewares.use('/api/ns', async (req, res) => {
      const response = await service.handle({
        url: `http://localhost/api/ns${req.url || '/'}`,
        method: req.method,
      });
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(await response.text());
    });
    server.httpServer?.once('close', service.close);
  }
  return {
    name: 'ns-proxy',
    closeBundle: service.close,
    configureServer: install,
    configurePreviewServer: install,
  };
}
