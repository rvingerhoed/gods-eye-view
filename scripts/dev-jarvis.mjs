import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Starts the dev server as a Jarvis-embeddable instance: HTTPS (Jarvis' own
 * cert) + a named frame-ancestors allowlist, on a dedicated port so the
 * default `npm run dev` instance (plain HTTP, blanket frame-ancestors 'none')
 * stays completely unaffected. A Node launcher, not an inline
 * `KEY=value vite` npm script, because npm's Windows script-shell is cmd.exe,
 * which does not support that POSIX syntax even when invoked from Git Bash.
 */
const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const jarvisCertDir = path.resolve(projectRoot, '..', 'jarvis', 'cert');
// Invoke vite's JS entry point directly via node, not the node_modules/.bin
// .cmd wrapper — spawning a .cmd file without a shell throws `spawn EINVAL`
// on Windows, and adding { shell: true } would reopen the same cmd.exe
// env-var-syntax problem this launcher exists to avoid.
const viteBin = path.join(projectRoot, 'node_modules', 'vite', 'bin', 'vite.js');

const child = spawn(process.execPath, [viteBin], {
  cwd: projectRoot,
  stdio: 'inherit',
  env: {
    ...process.env,
    GEV_FRAME_ANCESTORS: 'https://localhost:3001 https://jarvis.nextaiforge.dev',
    GEV_HTTPS_CERT: path.join(jarvisCertDir, 'jarvis-cert.pem'),
    GEV_HTTPS_KEY: path.join(jarvisCertDir, 'jarvis-key.pem'),
    PORT: '4174',
  },
});

child.on('exit', (code) => process.exit(code ?? 0));
child.on('error', (error) => {
  console.error('Failed to start vite for the Jarvis-embeddable instance:', error);
  process.exit(1);
});
