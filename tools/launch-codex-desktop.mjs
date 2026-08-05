import { spawn, spawnSync } from 'node:child_process';

const PROJECT_ROOT = new URL('..', import.meta.url).pathname.replace(/^\/(\w):/, '$1:').replace(/\//g, '\\').replace(/\\$/, '');
const PROXY_URL = 'http://127.0.0.1:20130/v1/models';

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function proxyIsReady() {
  try {
    const response = await fetch(PROXY_URL, { signal: AbortSignal.timeout(1500) });
    return response.ok;
  } catch {
    return false;
  }
}

function startVoidRouteTerminal() {
  spawn(
    'powershell.exe',
    [
      '-NoProfile',
      '-Command',
      `Start-Process cmd -ArgumentList '/k','title voidRoute TUI && bun run index.js' -WorkingDirectory '${PROJECT_ROOT}'`,
    ],
    { stdio: 'ignore', windowsHide: true },
  );
}

function patchedCodexIsRunning() {
  const check = spawnSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      '(Get-Process ChatGPT,Codex -ErrorAction SilentlyContinue | Where-Object { $_.Path -like \'*codex-desktop-patched*\' }).Count',
    ],
    { encoding: 'utf8' },
  );
  const count = Number.parseInt(check.stdout?.trim() ?? '0', 10);
  return Number.isFinite(count) && count > 0;
}

async function ensureProxy() {
  if (await proxyIsReady()) return;

  startVoidRouteTerminal();

  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (await proxyIsReady()) return;
    await sleep(500);
  }
  throw new Error('voidRoute proxy did not become ready on http://127.0.0.1:20130/v1');
}

await ensureProxy();

if (patchedCodexIsRunning()) {
  console.log('Patched Codex Desktop is already running; skipping relaunch.');
} else {
  const result = spawnSync(process.execPath, ['run', 'tools/patch-codex-desktop.mjs', '--launch'], {
    cwd: PROJECT_ROOT,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
