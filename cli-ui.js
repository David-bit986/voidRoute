import inquirer from 'inquirer';
import search from '@inquirer/search';
import chalk from 'chalk';
import http from 'http';
import fs from 'fs';
import path from 'path';
import crypto, { randomUUID } from 'crypto';
import {
  getSettings, updateSettings,
  getProviderConnections, createProviderConnection,
  deleteProviderConnection, deleteProviderConnectionsByProvider,
  updateProviderConnection,
  getCombos, createCombo, deleteCombo,
  createProviderNode, deleteProviderNode, getProviderNodeById,
  getProviderNodes, updateProviderNode,
  addCustomModel, deleteCustomModel, renameCustomModelAlias,
  getApiKeys, createApiKey, deleteApiKey,
} from './src/lib/db/index.js';
import { PROVIDERS as PROVIDER_ENDPOINTS } from './open-sse/config/providers.js';
import { PROVIDER_MODELS, PROVIDER_ID_TO_ALIAS, getModelsByProviderId } from './open-sse/config/providerModels.js';
import {
  CLAUDE_CONFIG, CODEX_CONFIG, GEMINI_CONFIG, ANTIGRAVITY_CONFIG,
  GITHUB_CONFIG, KIRO_CONFIG, CURSOR_CONFIG, KIMI_CODING_CONFIG,
  KILOCODE_CONFIG, CLINE_CONFIG, QWEN_CONFIG,
} from './src/lib/oauth/constants/oauth.js';
import { generatePKCE } from './src/lib/oauth/utils/pkce.js';
import { getProviderAlias, AI_PROVIDERS } from './src/shared/constants/providers.js';
import { resolveRoutedPrefix } from './src/sse/utils/routedPrefix.js';
import { getConsoleLogs, getConsoleEmitter } from './src/lib/consoleLogBuffer.js';
import { fetchProviderModels, syncProviderModels, resetSyncedModels } from './src/lib/modelSync.js';
import { AiderAdapter, ClaudeAdapter, ClineAdapter, CodexAdapter, HermesAdapter, OpenCodeAdapter, PiAdapter } from './src/lib/cli-config/index.js';

// ─── Provider Classification ────────────────────────────────────────────────
// Providers that use OAuth / device-code flows (NOT simple API keys)
const OAUTH_PROVIDERS = {
  claude:       { label: 'Claude Code (Pro/Max)',      flow: 'browser_oauth',  config: CLAUDE_CONFIG },
  codex:        { label: 'OpenAI Codex (Plus/Pro)',     flow: 'browser_oauth',  config: CODEX_CONFIG, fixedPort: 1455, callbackPath: '/auth/callback' },
  'gemini-cli': { label: 'Gemini CLI (Google)',         flow: 'browser_oauth',  config: GEMINI_CONFIG },
  antigravity:  { label: 'Antigravity (Google)',        flow: 'browser_oauth',  config: ANTIGRAVITY_CONFIG },
  github:       { label: 'GitHub Copilot',              flow: 'device_code',    config: GITHUB_CONFIG },
  kiro:         { label: 'Kiro AI (FREE)',              flow: 'device_code',    config: KIRO_CONFIG },
  'kimi-coding':{ label: 'Kimi Coding',                 flow: 'device_code',    config: KIMI_CODING_CONFIG },
  kilocode:     { label: 'Kilo Code',                   flow: 'device_code',    config: KILOCODE_CONFIG },
  cline:        { label: 'Cline',                       flow: 'browser_oauth',  config: CLINE_CONFIG },
  cursor:       { label: 'Cursor IDE (Import Token)',   flow: 'import_token',   config: CURSOR_CONFIG },
};

// All remaining providers use a simple API key
const API_KEY_PROVIDERS = Object.keys(PROVIDER_ENDPOINTS).filter(k => !OAUTH_PROVIDERS[k]);

// ─── Helpers ────────────────────────────────────────────────────────────────
function spin(text) {
  const frames = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'];
  let i = 0, iv;
  return {
    start() { if (process.stdout.isTTY) { iv = setInterval(() => process.stdout.write(`\r${frames[i++ % frames.length]} ${text}`), 80); } return this; },
    stop()  { if (iv) { clearInterval(iv); iv = null; } if (process.stdout.isTTY) process.stdout.write('\r\x1b[K'); },
    succeed(m) { this.stop(); console.log(chalk.green(`  ✅ ${m}`)); },
    fail(m)    { this.stop(); console.log(chalk.red(`  ❌ ${m}`)); },
  };
}

async function tryOpen(url) {
  try { const open = (await import('open')).default; await open(url); } catch { /* ignore */ }
}

const PROVIDER_DOCS_URLS = {
  openai: 'https://platform.openai.com/docs/models',
  anthropic: 'https://docs.anthropic.com/en/docs/about-claude/models',
  gemini: 'https://ai.google.dev/gemini-api/docs/models/gemini',
  openrouter: 'https://openrouter.ai/models',
  deepseek: 'https://api-docs.deepseek.com/quick_start/pricing',
  siliconflow: 'https://siliconflow.cn/models',
  together: 'https://docs.together.ai/docs/inference-models',
  groq: 'https://console.groq.com/docs/models',
  mistral: 'https://docs.mistral.ai/getting-started/models/',
  xai: 'https://docs.x.ai/docs#models',
  github: 'https://github.com/features/copilot',
  kiro: 'https://kiro.ai/docs',
};

function resizeAscii(asciiStr, targetWidth, targetHeight = null) {
  const lines = asciiStr.split('\n');
  const originalWidth = Math.max(...lines.map(l => l.length));
  const originalHeight = lines.length;
  
  const scaleX = targetWidth / originalWidth;
  const scaleY = targetHeight ? (targetHeight / originalHeight) : (scaleX * 0.5);

  const newHeight = targetHeight || Math.round(originalHeight * scaleX);
  const newLines = [];
  
  for (let y = 0; y < newHeight; y++) {
    const origY = Math.min(Math.floor(y / (scaleY || 1)), originalHeight - 1);
    const origLine = lines[origY] || '';
    let newLine = '';
    for (let x = 0; x < targetWidth; x++) {
      const origX = Math.min(Math.floor(x / scaleX), origLine.length - 1);
      newLine += origLine[origX] || ' ';
    }
    newLines.push(newLine);
  }
  return newLines;
}

// ─── Local OAuth Callback Server ────────────────────────────────────────────
function startCallbackServer(fixedPort = 0, callbackPath = '/callback') {
  return new Promise((resolve, reject) => {
    let callbackResolve;
    const callbackPromise = new Promise(r => { callbackResolve = r; });

    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === callbackPath || url.pathname === '/callback') {
        const params = Object.fromEntries(url.searchParams);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!DOCTYPE html><html><body style="font-family:system-ui;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#111;color:#0f0"><div style="text-align:center"><h1>✅ Authentication Successful</h1><p>You can close this tab.</p></div><script>setTimeout(()=>window.close(),2000)</script></body></html>`);
        callbackResolve(params);
      } else { res.writeHead(404); res.end(); }
    });

    server.listen(fixedPort, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ port, server, waitForCallback: () => callbackPromise, close: () => server.close() });
    });
    server.on('error', reject);
  });
}

// ─── OAuth: Browser-based Authorization Code Flow ───────────────────────────
async function doBrowserOAuth(providerId, oauthDef, appPort) {
  const config = oauthDef.config;
  const { codeVerifier, codeChallenge, state } = generatePKCE();
  const { port, waitForCallback, close } = await startCallbackServer(oauthDef.fixedPort || 0, oauthDef.callbackPath || '/callback');
  const redirectUri = `http://localhost:${port}${oauthDef.callbackPath || '/callback'}`;

  let authUrl;
  if (providerId === 'claude') {
    const params = new URLSearchParams({
      code: 'true', client_id: config.clientId, response_type: 'code',
      redirect_uri: redirectUri, scope: config.scopes.join(' '),
      code_challenge: codeChallenge, code_challenge_method: config.codeChallengeMethod, state,
    });
    authUrl = `${config.authorizeUrl}?${params}`;
  } else if (providerId === 'codex') {
    const params = { response_type: 'code', client_id: config.clientId, redirect_uri: redirectUri,
      scope: config.scope, code_challenge: codeChallenge, code_challenge_method: config.codeChallengeMethod,
      ...config.extraParams, state };
    const qs = Object.entries(params).map(([k,v]) => `${k}=${encodeURIComponent(v)}`).join('&');
    authUrl = `${config.authorizeUrl}?${qs}`;
  } else if (providerId === 'gemini-cli' || providerId === 'antigravity') {
    const params = new URLSearchParams({
      client_id: config.clientId, response_type: 'code', redirect_uri: redirectUri,
      scope: config.scopes.join(' '), state, access_type: 'offline', prompt: 'consent',
    });
    authUrl = `${config.authorizeUrl}?${params}`;
  } else if (providerId === 'cline') {
    const params = new URLSearchParams({ client_type: 'extension', callback_url: redirectUri, redirect_uri: redirectUri });
    authUrl = `${config.authorizeUrl}?${params}`;
  } else {
    throw new Error(`Unsupported browser OAuth provider: ${providerId}`);
  }

  console.log(chalk.cyan(`\n  Open this URL in your browser to authenticate:`));
  console.log(chalk.white(`  ${authUrl}\n`));
  await tryOpen(authUrl);

  const sp = spin('Waiting for authentication...').start();
  const params = await waitForCallback();
  sp.stop();
  close();

  if (params.error) throw new Error(params.error_description || params.error);
  if (!params.code) throw new Error('No authorization code received');

  // Exchange code for tokens
  let code = params.code;
  let tokenBody, tokenHeaders, tokenUrl;

  if (providerId === 'claude') {
    if (code.includes('#')) code = code.split('#')[0];
    tokenUrl = config.tokenUrl;
    tokenHeaders = { 'Content-Type': 'application/json', Accept: 'application/json' };
    tokenBody = JSON.stringify({ code, state: params.state || state, grant_type: 'authorization_code',
      client_id: config.clientId, redirect_uri: redirectUri, code_verifier: codeVerifier });
  } else if (providerId === 'codex') {
    tokenUrl = config.tokenUrl;
    tokenHeaders = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
    tokenBody = new URLSearchParams({ grant_type: 'authorization_code', client_id: config.clientId,
      code, redirect_uri: redirectUri, code_verifier: codeVerifier }).toString();
  } else if (providerId === 'gemini-cli' || providerId === 'antigravity') {
    tokenUrl = config.tokenUrl;
    tokenHeaders = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
    tokenBody = new URLSearchParams({ grant_type: 'authorization_code', client_id: config.clientId,
      client_secret: config.clientSecret, code, redirect_uri: redirectUri }).toString();
  } else if (providerId === 'cline') {
    // Cline encodes token data as base64 in the code param
    try {
      let b64 = code;
      const pad = 4 - (b64.length % 4);
      if (pad !== 4) b64 += '='.repeat(pad);
      const decoded = Buffer.from(b64, 'base64').toString('utf-8');
      const lastBrace = decoded.lastIndexOf('}');
      if (lastBrace === -1) throw new Error('No JSON');
      const data = JSON.parse(decoded.substring(0, lastBrace + 1));
      return { accessToken: data.accessToken, refreshToken: data.refreshToken, email: data.email, expiresIn: 3600 };
    } catch {
      tokenUrl = config.tokenExchangeUrl;
      tokenHeaders = { 'Content-Type': 'application/json', Accept: 'application/json' };
      tokenBody = JSON.stringify({ grant_type: 'authorization_code', code, client_type: 'extension', redirect_uri: redirectUri });
    }
  }

  const res = await fetch(tokenUrl, { method: 'POST', headers: tokenHeaders, body: tokenBody });
  if (!res.ok) throw new Error(`Token exchange failed: ${await res.text()}`);
  const tokens = await res.json();

  // Post-exchange steps
  let email, projectId;
  if (providerId === 'gemini-cli' || providerId === 'antigravity') {
    try {
      const uiRes = await fetch(`${config.userInfoUrl}?alt=json`, { headers: { Authorization: `Bearer ${tokens.access_token}` } });
      if (uiRes.ok) { const ui = await uiRes.json(); email = ui.email; }
    } catch { /* ignore */ }
    try {
      const endpoint = providerId === 'antigravity' ? config.loadCodeAssistEndpoint : 'https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist';
      const loadRes = await fetch(endpoint, { method: 'POST',
        headers: { Authorization: `Bearer ${tokens.access_token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ metadata: { ideType: 9, platform: 5, pluginType: 2 }, ...(providerId === 'antigravity' ? {} : { mode: 1 }) }) });
      if (loadRes.ok) { const d = await loadRes.json(); projectId = d.cloudaicompanionProject?.id || d.cloudaicompanionProject || ''; }
    } catch { /* ignore */ }
  }

  return {
    accessToken: tokens.access_token, refreshToken: tokens.refresh_token,
    expiresIn: tokens.expires_in, email, projectId,
    ...(tokens.id_token ? { idToken: tokens.id_token } : {}),
  };
}

// ─── OAuth: Device Code Flow ────────────────────────────────────────────────
async function doDeviceCodeFlow(providerId, oauthDef) {
  const config = oauthDef.config;

  if (providerId === 'github') {
    // GitHub device code flow
    const dcRes = await fetch(config.deviceCodeUrl, { method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ client_id: config.clientId, scope: config.scopes }) });
    if (!dcRes.ok) throw new Error(`Device code request failed: ${await dcRes.text()}`);
    const dc = await dcRes.json();

    console.log(chalk.cyan(`\n  ➡  Go to: ${chalk.white.bold(dc.verification_uri)}`));
    console.log(chalk.cyan(`  ➡  Enter code: ${chalk.white.bold(dc.user_code)}\n`));
    await tryOpen(dc.verification_uri);

    let interval = (dc.interval || 5) * 1000;
    const sp = spin('Waiting for GitHub authorization...').start();

    while (true) {
      await new Promise(r => setTimeout(r, interval));
      const pRes = await fetch(config.tokenUrl, { method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams({ client_id: config.clientId, device_code: dc.device_code,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }) });
      let data; try { data = await pRes.json(); } catch { continue; }

      if (data.access_token) {
        sp.succeed('GitHub authenticated!');
        // Get copilot token + user info
        let copilotToken, userInfo;
        try {
          const cpRes = await fetch(config.copilotTokenUrl, {
            headers: { Authorization: `Bearer ${data.access_token}`, Accept: 'application/json',
              'X-GitHub-Api-Version': config.apiVersion, 'User-Agent': config.userAgent } });
          if (cpRes.ok) copilotToken = await cpRes.json();
        } catch { /* ignore */ }
        try {
          const uiRes = await fetch(config.userInfoUrl, {
            headers: { Authorization: `Bearer ${data.access_token}`, Accept: 'application/json',
              'X-GitHub-Api-Version': config.apiVersion, 'User-Agent': config.userAgent } });
          if (uiRes.ok) userInfo = await uiRes.json();
        } catch { /* ignore */ }

        return {
          accessToken: data.access_token, refreshToken: data.refresh_token,
          providerSpecificData: {
            copilotToken: copilotToken?.token, copilotTokenExpiresAt: copilotToken?.expires_at,
            githubUserId: userInfo?.id, githubLogin: userInfo?.login,
            githubName: userInfo?.name, githubEmail: userInfo?.email,
          },
          email: userInfo?.login,
        };
      }
      if (data.error === 'slow_down') { interval += 5000; continue; }
      if (data.error === 'authorization_pending') continue;
      if (data.error === 'expired_token') { sp.fail('Code expired.'); throw new Error('expired'); }
      if (data.error === 'access_denied') { sp.fail('Denied.'); throw new Error('denied'); }
      sp.fail(data.error_description || data.error); throw new Error(data.error);
    }
  }

  if (providerId === 'kiro') {
    // Kiro uses AWS SSO OIDC
    const region = 'us-east-1';
    const regRes = await fetch(`https://oidc.${region}.amazonaws.com/client/register`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ clientName: config.clientName, clientType: config.clientType,
        scopes: config.scopes, grantTypes: config.grantTypes, issuerUrl: config.issuerUrl }) });
    if (!regRes.ok) throw new Error(`Client registration failed: ${await regRes.text()}`);
    const clientInfo = await regRes.json();

    const daRes = await fetch(`https://oidc.${region}.amazonaws.com/device_authorization`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ clientId: clientInfo.clientId, clientSecret: clientInfo.clientSecret,
        startUrl: config.startUrl }) });
    if (!daRes.ok) throw new Error(`Device authorization failed: ${await daRes.text()}`);
    const da = await daRes.json();

    console.log(chalk.cyan(`\n  ➡  Go to: ${chalk.white.bold(da.verificationUriComplete || da.verificationUri)}`));
    if (da.userCode) console.log(chalk.cyan(`  ➡  Code: ${chalk.white.bold(da.userCode)}`));
    console.log('');
    await tryOpen(da.verificationUriComplete || da.verificationUri);

    const sp = spin('Waiting for Kiro authorization...').start();
    let interval = (da.interval || 5) * 1000;

    while (true) {
      await new Promise(r => setTimeout(r, interval));
      const pRes = await fetch(`https://oidc.${region}.amazonaws.com/token`, { method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ clientId: clientInfo.clientId, clientSecret: clientInfo.clientSecret,
          deviceCode: da.deviceCode, grantType: 'urn:ietf:params:oauth:grant-type:device_code' }) });
      let data; try { data = await pRes.json(); } catch { continue; }

      if (data.accessToken) {
        sp.succeed('Kiro authenticated!');
        return {
          accessToken: data.accessToken, refreshToken: data.refreshToken,
          expiresIn: data.expiresIn,
          providerSpecificData: {
            profileArn: data.profileArn || null,
            clientId: clientInfo.clientId, clientSecret: clientInfo.clientSecret,
            region, authMethod: 'builder-id', startUrl: config.startUrl,
          },
        };
      }
      if (data.error === 'AuthorizationPendingException' || data.error === 'authorization_pending') continue;
      if (data.error === 'SlowDownException' || data.error === 'slow_down') { interval += 5000; continue; }
      if (data.error === 'ExpiredTokenException') { sp.fail('Code expired.'); throw new Error('expired'); }
      sp.fail(data.error || 'Unknown error'); throw new Error(data.error);
    }
  }

  if (providerId === 'kimi-coding') {
    const dcRes = await fetch(config.deviceCodeUrl, { method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ client_id: config.clientId }) });
    if (!dcRes.ok) throw new Error(`Device code failed: ${await dcRes.text()}`);
    const dc = await dcRes.json();

    const verifyUrl = dc.verification_uri_complete || dc.verification_uri || `https://www.kimi.com/code/authorize_device?user_code=${dc.user_code}`;
    console.log(chalk.cyan(`\n  ➡  Go to: ${chalk.white.bold(verifyUrl)}`));
    if (dc.user_code) console.log(chalk.cyan(`  ➡  Code: ${chalk.white.bold(dc.user_code)}`));
    console.log('');
    await tryOpen(verifyUrl);

    const sp = spin('Waiting for Kimi authorization...').start();
    let interval = (dc.interval || 5) * 1000;
    while (true) {
      await new Promise(r => setTimeout(r, interval));
      const pRes = await fetch(config.tokenUrl, { method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          client_id: config.clientId, device_code: dc.device_code }) });
      let data; try { data = await pRes.json(); } catch { continue; }
      if (data.access_token) { sp.succeed('Kimi authenticated!'); return { accessToken: data.access_token, refreshToken: data.refresh_token, expiresIn: data.expires_in }; }
      if (data.error === 'authorization_pending') continue;
      if (data.error === 'slow_down') { interval += 5000; continue; }
      sp.fail(data.error); throw new Error(data.error);
    }
  }

  if (providerId === 'kilocode') {
    const dcRes = await fetch(config.initiateUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
    if (!dcRes.ok) throw new Error(`KiloCode auth failed: ${await dcRes.text()}`);
    const dc = await dcRes.json();

    console.log(chalk.cyan(`\n  ➡  Go to: ${chalk.white.bold(dc.verificationUrl)}\n`));
    await tryOpen(dc.verificationUrl);

    const sp = spin('Waiting for KiloCode authorization...').start();
    while (true) {
      await new Promise(r => setTimeout(r, 3000));
      const pRes = await fetch(`${config.pollUrlBase}/${dc.code}`);
      if (pRes.status === 202) continue;
      if (pRes.status === 403) { sp.fail('Denied.'); throw new Error('denied'); }
      if (pRes.status === 410) { sp.fail('Expired.'); throw new Error('expired'); }
      if (!pRes.ok) continue;
      const data = await pRes.json();
      if (data.status === 'approved' && data.token) {
        sp.succeed('KiloCode authenticated!');
        return { accessToken: data.token, email: data.userEmail };
      }
    }
  }

  throw new Error(`Unsupported device_code provider: ${providerId}`);
}

// ─── Import Token Flow (Cursor) ─────────────────────────────────────────────
async function doImportToken(providerId) {
  const { accessToken } = await inquirer.prompt([{
    type: 'input', name: 'accessToken',
    message: 'Paste your Cursor access token (from state.vscdb → cursorAuth/accessToken):',
  }]);
  if (!accessToken) throw new Error('No token provided');

  let machineId;
  const { mid } = await inquirer.prompt([{
    type: 'input', name: 'mid',
    message: 'Paste machine ID (optional, from state.vscdb → storage.serviceMachineId):',
  }]);
  machineId = mid || undefined;

  return { accessToken, providerSpecificData: { machineId, authMethod: 'imported' }, expiresIn: 86400 };
}

// ═══════════════════════════════════════════════════════════════════════════
//  MAIN CLI LOOP
// ═══════════════════════════════════════════════════════════════════════════
function displayWelcomeAscii(port) {
  try {
    const assetsDir = path.join(process.cwd(), 'assets');
    const galaxyPath = path.join(assetsDir, 'galaxtASCI.txt');
    const namePath = path.join(assetsDir, 'nameASCI.txt');
    
    if (fs.existsSync(galaxyPath) && fs.existsSync(namePath)) {
      const galaxyRaw = fs.readFileSync(galaxyPath, 'utf8');
      const nameRaw = fs.readFileSync(namePath, 'utf8');
      
      const galaxyLines = resizeAscii(galaxyRaw, 35, 12);
      const nameLines = resizeAscii(nameRaw, 100, 12);
      
      const combined = [];
      for (let i = 0; i < 12; i++) {
        const gLine = galaxyLines[i] || ' '.repeat(35);
        const nLine = nameLines[i] || ' '.repeat(100);
        combined.push(chalk.cyan(gLine) + '        ' + chalk.magenta.bold(nLine));
      }
      
      console.log(combined.join('\n'));
      console.log(`\n  ${chalk.gray(`Proxy endpoint: ${chalk.white.bold(`http://localhost:${port}/v1`)}`)}\n`);
    } else {
      const banner = `
${chalk.magenta.bold('  ╔══════════════════════════════════════╗')}
${chalk.magenta.bold('  ║')}   ${chalk.white.bold('🚀 voidRoute CLI')}                    ${chalk.magenta.bold('║')}
${chalk.magenta.bold('  ╚══════════════════════════════════════╝')}
  ${chalk.gray(`Proxy endpoint: ${chalk.white(`http://localhost:${port}/v1`)}`)}
`;
      console.log(banner);
    }
  } catch (err) {
    // silent fallback
  }
}

export async function setupCLI(port) {
  console.clear();
  // Disable mouse tracking/reporting so mouse clicks don't interfere with the list selector
  process.stdout.write('\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1015l\x1b[?1007l');
  
  global.TUI_ACTIVE = true;

  while (true) {
    console.clear();
    displayWelcomeAscii(port);

    const { getProviderConnections } = await import('./src/lib/db/index.js');
    const conns = await getProviderConnections();
    const activeCount = conns.filter(c => c.isActive).length;

    console.log(chalk.gray(`  Providers: ${activeCount > 0 ? chalk.green(activeCount + ' active') : chalk.red('0 active')}\n`));

    const { action } = await inquirer.prompt([{
      type: 'list', name: 'action', message: chalk.bold('Main Menu:'),
      choices: [
        { name: '🌐 Manage Providers', value: 'providers' },
        { name: '🚀 CLI Tools Config', value: 'cli_tools' },
        { name: '🔧 Settings',         value: 'settings' },
        { name: '📊 View Live Logs',   value: 'logs' },
        { name: '❌ Exit',             value: 'exit' },
      ],
      loop: false
    }]);

    if (action === 'exit') { console.log(chalk.gray('  Bye!')); process.exit(0); }

    // ─── LOGS ─────────────────────────────────────────────────────────────
    if (action === 'logs') {
      console.clear();
      console.log(chalk.cyan('  ── Live Server Logs ──'));
      console.log(chalk.gray('  (Press ANY key to return to menu)\n'));
      
      global.TUI_ACTIVE = false;
      
      const logs = getConsoleLogs();
      logs.forEach(l => process.stdout.write(l + '\n'));
      
      const emitter = getConsoleEmitter();
      const onLine = (line) => process.stdout.write(line + '\n');
      emitter.on('line', onLine);

      await new Promise((resolve) => {
        process.stdin.setRawMode(true);
        process.stdin.resume();
        process.stdin.once('data', () => {
          process.stdin.setRawMode(false);
          resolve();
        });
      });

      emitter.off('line', onLine);
      global.TUI_ACTIVE = true;
      console.clear();
      displayWelcomeAscii(port);
      continue;
    }
    // ─── PROVIDERS ────────────────────────────────────────────────────────
    if (action === 'providers') {
      await manageProviders(port);
    }

    // ─── COMBOS ───────────────────────────────────────────────────────────
    if (action === 'combos') {
      await manageCombos();
    }

    // ─── CLI TOOLS CONFIG ─────────────────────────────────────────────────
    if (action === 'cli_tools') {
      await manageCliTools(port);
    }

    // ─── SETTINGS ─────────────────────────────────────────────────────────
    if (action === 'settings') {
      await manageSettings();
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  PROVIDER MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════
async function manageProviders(port) {
  while (true) {
    const conns = await getProviderConnections();
    const nodes = await getProviderNodes();
    const nodeById = new Map();
    for (const n of nodes) nodeById.set(n.id, n);
    console.log(chalk.cyan('\n  ── Your Providers ──'));
    if (conns.length === 0) {
      console.log(chalk.gray('  (none connected)'));
    } else {
      for (const c of conns) {
        const status = c.isActive ? chalk.green('●') : chalk.red('○');
        const auth = c.authType === 'oauth' ? chalk.magenta('OAuth') : chalk.yellow('API Key');
        const node = nodeById.get(c.provider);
        if (node) {
          const prefix = node.prefix || node.name || c.provider;
          console.log(`  ${status} ${chalk.white.bold(prefix)} ${chalk.gray(`(${c.name || 'unnamed'})`)} [${auth}]`);
        } else {
          const dispName = c.name || c.email || 'Unnamed';
          console.log(`  ${status} ${chalk.white.bold(c.provider)} — ${dispName} [${auth}]`);
        }
      }
    }
    console.log('');

    let { pAction } = await inquirer.prompt([{
      type: 'list', name: 'pAction', message: 'Provider Options:',
      choices: [
        { name: '🔐 Add OAuth Provider (GitHub, Claude, Kiro, Gemini...)', value: 'add_oauth' },
        { name: '🔌 Add API Key / Local / Custom Provider',                value: 'add_other' },
        { name: '✏️ Rename a Provider',                                    value: 'rename' },
        { name: '🗑️ Remove a Provider',                                    value: 'remove' },
        new inquirer.Separator(),
        { name: '🔙 Back',                                                 value: 'back' },
      ],
      loop: false
    }]);

    if (pAction === 'back') return;

    if (pAction === 'add_other') {
      const { otherAction } = await inquirer.prompt([{
        type: 'list', name: 'otherAction', message: 'Select type of provider to add:',
        choices: [
          { name: '🔑 Standard API Key Provider (OpenAI, Anthropic, DeepSeek...)', value: 'add_apikey' },
          { name: '🏠 Local Network Server (LM Studio, llama.cpp, vLLM...)',       value: 'add_local' },
          { name: '🛠️ Custom API Endpoint (OpenAI-compatible)',                     value: 'add_custom' },
          new inquirer.Separator(),
          { name: '🔙 Back',                                                       value: 'back' },
        ],
        loop: false
      }]);
      
      if (otherAction === 'back') continue;
      
      // Map otherAction to original handlers below
      if (otherAction === 'add_apikey') pAction = 'add_apikey';
      if (otherAction === 'add_local') pAction = 'add_local';
      if (otherAction === 'add_custom') pAction = 'add_custom';
    }

    if (pAction === 'add_oauth') {
      const oauthChoices = Object.entries(OAUTH_PROVIDERS).map(([id, def]) => {
        const isConnected = conns.some(c => c.provider === id);
        return { name: `${def.label} (${id})${isConnected ? chalk.gray(' — Already Connected') : ''}`, value: id };
      });
      oauthChoices.push(new inquirer.Separator(), { name: '🔙 Back', value: 'back' });
      
      const { providerId } = await inquirer.prompt([{ 
        type: 'list', name: 'providerId', message: 'Select OAuth Provider:', 
        choices: oauthChoices, loop: false 
      }]);
      
      if (providerId === 'back') continue;

      const { connectionName } = await inquirer.prompt([{ type: 'input', name: 'connectionName', message: 'Connection Name:', default: 'My Account' }]);

      const oauthDef = OAUTH_PROVIDERS[providerId];
      try {
        let result;
        if (oauthDef.flow === 'browser_oauth') {
          result = await doBrowserOAuth(providerId, oauthDef, port);
        } else if (oauthDef.flow === 'device_code') {
          result = await doDeviceCodeFlow(providerId, oauthDef);
        } else if (oauthDef.flow === 'import_token') {
          result = await doImportToken(providerId);
        }

        await createProviderConnection({
          provider: providerId,
          name: connectionName,
          accessToken: result.accessToken,
          refreshToken: result.refreshToken || null,
          expiresIn: result.expiresIn || null,
          email: result.email || null,
          projectId: result.projectId || null,
          authType: 'oauth',
          isActive: true,
          ...(result.providerSpecificData ? { providerSpecificData: result.providerSpecificData } : {}),
          ...(result.idToken ? { idToken: result.idToken } : {}),
        });

        console.log(chalk.green(`\n  ✅ ${providerId} connected successfully!`));
        if (result.email) console.log(chalk.gray(`     Account: ${result.email}`));
        console.log(chalk.yellow(`     Use model prefix: ${providerId === 'github' ? 'gh' : providerId === 'gemini-cli' ? 'gc' : providerId === 'claude' ? 'cc' : providerId === 'codex' ? 'cx' : providerId === 'antigravity' ? 'ag' : providerId === 'kiro' ? 'kr' : providerId}/<model>\n`));
      } catch (e) {
        console.log(chalk.red(`  ❌ OAuth failed: ${e.message}\n`));
      }
    }

    if (pAction === 'add_apikey') {
      const providerChoices = API_KEY_PROVIDERS.map(k => ({
        name: k,
        value: k,
        description: conns.some(c => c.provider === k) ? 'Already connected' : undefined,
      }));
      providerChoices.push(new inquirer.Separator(), { name: '🔙 Back', value: 'back' });

      const providerId = await search({
        message: 'Search and select a provider:',
        source: async (term) => {
          if (!term) return providerChoices;
          const t = term.toLowerCase();
          return providerChoices.filter(c => c.value === 'back' || (c.name && c.name.toLowerCase().includes(t)));
        },
        pageSize: 10,
      });

      if (!providerId || providerId === 'back') continue;

      const { connectionName, apiKey } = await inquirer.prompt([
        { type: 'input', name: 'connectionName', message: 'Connection Name:', default: 'My Account' },
        { type: 'password', name: 'apiKey', message: 'API Key:', mask: '*' },
      ]);

      if (apiKey) {
        await createProviderConnection({ provider: providerId, name: connectionName, accessToken: apiKey, authType: 'apikey', isActive: true });
        console.log(chalk.green(`\n  ✅ ${providerId} added successfully!\n`));
      }
    }

    if (pAction === 'add_local') {
      console.log(chalk.cyan('\n  ── Add Local Network Server ──\n'));
      const { name } = await inquirer.prompt([{
        type: 'input', name: 'name',
        message: 'Provider name (e.g. "my-pc", "lm-studio") [Leave empty to cancel]:',
        default: 'local-pc',
      }]);
      if (!name) continue;
      
      const { ipAndPort } = await inquirer.prompt([{
        type: 'input', name: 'ipAndPort',
        message: 'Enter IP and Port (e.g., 192.168.50.39:8080 or localhost:1234):',
        default: '192.168.50.39:8080',
        validate: (v) => v.length > 0 || 'IP and Port are required',
      }]);

      const { apiKey } = await inquirer.prompt([{
        type: 'input', name: 'apiKey',
        message: 'API Key (Leave empty if none is required):',
        default: '',
      }]);

      let baseUrl = ipAndPort;
      if (!baseUrl.startsWith('http')) baseUrl = `http://${baseUrl}`;
      if (!baseUrl.endsWith('/v1')) baseUrl = `${baseUrl.replace(/\/$/, '')}/v1`;

      console.log(chalk.gray(`  Using Base URL: ${baseUrl}`));

      const safeId = name.replace(/[^a-z0-9-]/gi, '-').replace(/-+/g, '-').toLowerCase();
      const nodeId = `openai-compatible-${safeId}-${randomUUID().slice(0, 8)}`;

      await createProviderNode({
        id: nodeId,
        type: 'openai-compatible',
        name,
        prefix: name,
        apiType: 'openai',
        baseUrl,
      });

      await createProviderConnection({
        provider: nodeId,
        name,
        accessToken: apiKey.trim(),
        authType: 'apikey',
        isActive: true,
        providerSpecificData: { baseUrl },
      });

      console.log(chalk.green(`\n  ✅ Local provider "${name}" created!\n`));
      
      console.log(chalk.cyan(`  Attempting to auto-detect models from ${baseUrl}...`));
      try {
        const fetchRes = await fetch(`${baseUrl}/models`, { headers: { 'Accept': 'application/json' }, signal: AbortSignal.timeout(3000) });
        if (fetchRes.ok) {
          const data = await fetchRes.json();
          const models = data.data ? data.data : (Array.isArray(data) ? data : []);
          let added = 0;
          for (const m of models) {
            const mId = m.id || m.name || m;
            if (typeof mId === 'string') {
              await addCustomModel({ providerAlias: name, id: mId, type: 'llm', name: mId });
              console.log(chalk.green(`  ✅ Found & Added model: ${mId}`));
              added++;
            }
          }
          if (added > 0) {
            console.log(chalk.green(`\n  ✅ Successfully auto-detected and added ${added} models!`));
            continue;
          }
        }
      } catch (e) {}

      console.log(chalk.yellow(`  ⚠️ Could not auto-detect models from ${baseUrl}/models.`));
      
      const models = [];
      console.log(chalk.cyan('\n  Please add your loaded model name manually (e.g. "llama-3-8b"):\n'));

      while (true) {
        if (models.length > 0) console.log(chalk.gray(`  Current models: ${models.join(', ')}`));
        const { modelAction } = await inquirer.prompt([{
          type: 'list', name: 'modelAction',
          message: 'Model Options:',
          choices: [
            { name: '➕ Add Model', value: 'add' },
            ...(models.length > 0 ? [{ name: '🗑️  Delete Last Model', value: 'delete' }] : []),
            { name: '✅ Save & Finish', value: 'finish' },
          ],
        }]);

        if (modelAction === 'delete') {
          const removed = models.pop();
          console.log(chalk.yellow(`  🗑️  Removed: ${removed}\n`));
          continue;
        }

        if (modelAction === 'finish') {
          for (const modelId of models) {
            await addCustomModel({ providerAlias: name, id: modelId, type: 'llm', name: modelId });
          }
          console.log(chalk.green(`\n  ✅ Custom provider "${name}" configured with ${models.length} models!\n`));
          break;
        }

        const { modelId } = await inquirer.prompt([{
          type: 'input', name: 'modelId',
          message: 'Exact Model ID/Name (as it appears in your server):',
          validate: (v) => v.length > 0 || 'Enter a model ID',
        }]);
        models.push(modelId.trim());
        console.log(chalk.green(`  ✅ Added: ${modelId.trim()}\n`));
      }
    }

    if (pAction === 'add_custom') {
      console.log(chalk.cyan('\n  ── Create Custom OpenAI-Compatible Provider ──\n'));
      const { name } = await inquirer.prompt([{
        type: 'input', name: 'name',
        message: 'Provider name (used as model prefix, e.g. "my-api" → my-api/model) [Leave empty to cancel]:',
      }]);
      if (!name) continue;

      const { baseUrl } = await inquirer.prompt([{
        type: 'input', name: 'baseUrl',
        message: 'Base URL (OpenAI-compatible endpoint):',
        default: 'https://api.example.com/v1',
        validate: (v) => v.length > 0 || 'URL is required',
      }]);

      const { apiKey } = await inquirer.prompt([{
        type: 'password', name: 'apiKey',
        message: 'API Key (optional, can add/edit later):',
        mask: '*',
      }]);

      const safeId = name.replace(/[^a-z0-9-]/gi, '-').replace(/-+/g, '-').toLowerCase();
      const nodeId = `openai-compatible-${safeId}-${randomUUID().slice(0, 8)}`;

      await createProviderNode({
        id: nodeId,
        type: 'openai-compatible',
        name,
        prefix: name,
        apiType: 'openai',
        baseUrl,
      });

      if (apiKey) {
        await createProviderConnection({
          provider: nodeId,
          name,
          accessToken: apiKey,
          authType: 'apikey',
          isActive: true,
          providerSpecificData: { baseUrl },
        });
      } else {
        await createProviderConnection({
          provider: nodeId,
          name,
          accessToken: '',
          authType: 'apikey',
          isActive: true,
          providerSpecificData: { baseUrl },
        });
      }

      const models = [];
      console.log(chalk.cyan('\n  Add models one by one. Keep empty or choose finish when done.\n'));

      while (true) {
        if (models.length > 0) {
          console.log(chalk.gray(`  Current models: ${models.join(', ')}`));
        }

        const { modelAction } = await inquirer.prompt([{
          type: 'list', name: 'modelAction',
          message: 'Model:',
          choices: [
            { name: '➕ Add Model', value: 'add' },
            ...(models.length > 0 ? [{ name: '🗑️  Delete Last Model', value: 'delete' }] : []),
            { name: '✅ Save & Finish', value: 'finish' },
            { name: '❌ Cancel (discard)', value: 'cancel' },
          ],
        }]);

        if (modelAction === 'cancel') {
          await deleteProviderNode(nodeId);
          await deleteProviderConnectionsByProvider(nodeId);
          console.log(chalk.gray('  Cancelled. Provider discarded.\n'));
          break;
        }

        if (modelAction === 'delete') {
          const removed = models.pop();
          console.log(chalk.yellow(`  🗑️  Removed: ${removed}\n`));
          continue;
        }

        if (modelAction === 'finish') {
          for (const modelId of models) {
            await addCustomModel({
              providerAlias: name,
              id: modelId,
              type: 'llm',
              name: modelId,
            });
          }
          console.log(chalk.green(`\n  ✅ Custom provider "${name}" created!`));
          console.log(chalk.gray(`     Provider ID: ${nodeId}`));
          console.log(chalk.gray(`     Models: ${models.join(', ') || '(none)'}\n`));
          break;
        }

        const { modelId } = await inquirer.prompt([{
          type: 'input', name: 'modelId',
          message: 'Model ID (e.g. gpt-4o):',
          validate: (v) => v.length > 0 || 'Enter a model ID',
        }]);
        models.push(modelId.trim());
        console.log(chalk.green(`  ✅ Added: ${modelId.trim()}\n`));
      }
    }
    if (pAction === 'rename') {
      const nodeTypes = new Set(['openai-compatible', 'anthropic-compatible', 'custom-embedding']);
      const renameable = (await getProviderNodes()).filter(n => nodeTypes.has(n.type));
      if (renameable.length === 0) {
        console.log(chalk.gray('  No renameable (custom) providers found.'));
        continue;
      }
      const choices = renameable.map(n => ({
        name: `${n.prefix || n.name || n.id}  ${chalk.gray(`(${n.type})`)}`,
        value: n.id,
      }));
      choices.push(new inquirer.Separator(), { name: '🔙 Cancel', value: null });

      const { nodeId } = await inquirer.prompt([{
        type: 'list', name: 'nodeId', message: 'Rename which provider?',
        choices, loop: false,
      }]);
      if (!nodeId) continue;
      const node = renameable.find(n => n.id === nodeId);

      const { newName } = await inquirer.prompt([{
        type: 'input', name: 'newName',
        message: 'New display name (shown in lists) [empty to cancel]:',
        default: node.name || node.prefix,
        validate: (v) => v.trim().length > 0 || 'A name is required',
      }]);
      if (!newName.trim()) continue;
      const newNameTrimmed = newName.trim();

      const { newPrefix } = await inquirer.prompt([{
        type: 'input', name: 'newPrefix',
        message: `New model prefix (${newNameTrimmed}/model IDs). Default keeps "${node.prefix || node.name}":`,
        default: node.prefix || node.name,
        validate: (v) => v.trim().length > 0 || 'A prefix is required',
      }]);
      if (!newPrefix.trim()) continue;
      const newPrefixTrimmed = newPrefix.trim();

      const oldPrefix = node.prefix || node.name;
      const prefixChanged = oldPrefix !== newPrefixTrimmed;
      const migrated = prefixChanged
        ? await renameCustomModelAlias(oldPrefix, newPrefixTrimmed)
        : { renamedModels: 0, renamedAliases: 0 };

      await updateProviderNode(node.id, {
        name: newNameTrimmed,
        ...(prefixChanged ? { prefix: newPrefixTrimmed } : {}),
      });

      const nodeConns = await getProviderConnections({ provider: node.id });
      for (const c of nodeConns) {
        await updateProviderConnection(c.id, { name: newNameTrimmed });
      }

      console.log(chalk.green(`\n  ✅ Provider renamed: "${node.name || nodeId}" → "${newNameTrimmed}".`));
      if (prefixChanged) {
        console.log(chalk.green(`     Model prefix: ${oldPrefix}/ → ${newPrefixTrimmed}/ (${migrated.renamedModels} models, ${migrated.renamedAliases} aliases migrated).`));
        console.log(chalk.yellow('     ℹ️  Re-apply your CLI tool config (CLI Tools Config → Codex → Re-apply) to refresh routed picker names.\n'));
      }
    }

    if (pAction === 'remove') {
      const conns = await getProviderConnections();
      if (conns.length === 0) { console.log(chalk.gray('  No providers to remove.')); continue; }
      const { connId } = await inquirer.prompt([{
        type: 'list', name: 'connId', message: 'Remove which connection?',
        choices: [...conns.map(c => ({ name: `${c.provider} — ${c.name || c.email || c.id}`, value: c.id })), { name: '🔙 Cancel', value: null }],
      }]);
      if (connId) {
        await deleteProviderConnection(connId);
        console.log(chalk.green('  ✅ Removed.\n'));
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  COMBO MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════
async function manageCombos() {
  while (true) {
    const combos = await getCombos();
    console.log(chalk.cyan('\n  ── Your Combos ──'));
    if (combos.length === 0) {
      console.log(chalk.gray('  (none created)'));
    } else {
      for (const c of combos) {
        const models = (c.models || []).map(m => `${m.provider}/${m.model}`).join(' → ');
        console.log(`  ${chalk.white.bold(c.name)} : ${models}`);
      }
    }
    console.log('');

    const { cAction } = await inquirer.prompt([{
      type: 'list', name: 'cAction', message: 'Combo Options:',
      choices: [
        { name: '🪄  Create Auto-Combo (Use all connected providers)', value: 'auto' },
        { name: '➕  Create Custom Combo', value: 'create' },
        { name: '🗑️   Delete Combo', value: 'delete' },
        { name: '🔙  Back',         value: 'back' },
      ],
    }]);

    if (cAction === 'back') return;

    if (cAction === 'auto') {
      const conns = await getProviderConnections();
      const active = conns.filter(c => c.isActive);
      if (active.length === 0) {
        console.log(chalk.red('  ❌ You have no active providers to build an auto-combo.'));
        continue;
      }
      
      const { name } = await inquirer.prompt([{ type: 'input', name: 'name', message: 'Auto-Combo name:', default: 'auto-fallback' }]);
      if (!name) continue;
      
      const models = [];
      for (const c of active) {
        const sp = spin(`Fetching latest models from ${c.provider}...`).start();
        const fetchedModels = await fetchProviderModels(c.provider, c);
        sp.stop();
        
        let providerModels = [];
        if (fetchedModels.length > 0) {
          providerModels = fetchedModels.filter(m => !m.type || m.type === 'llm');
        } else {
          providerModels = getModelsByProviderId(c.provider).filter(m => !m.type || m.type === 'llm');
        }
        
        if (providerModels.length > 0) {
          // Take up to 3 top models per provider
          for (const m of providerModels.slice(0, 3)) {
            models.push({ provider: c.provider, model: m.id });
          }
        } else {
          models.push({ provider: c.provider, model: 'auto' });
        }
      }
      
      await createCombo({ id: randomUUID(), name, models });
      console.log(chalk.green(`  ✅ Auto-Combo "${name}" created with ${models.length} fallback models.\n`));
    }

    if (cAction === 'create') {
      const { name } = await inquirer.prompt([{ type: 'input', name: 'name', message: 'Combo name (e.g. my-stack):' }]);
      if (!name) continue;
      
      const conns = await getProviderConnections();
      const activeProviders = conns.filter(c => c.isActive).map(c => c.provider);
      
      if (activeProviders.length === 0) {
         console.log(chalk.red('  ❌ No active providers found. Add one first.'));
         continue;
      }
      
      const providerChoices = activeProviders.map(p => ({ name: p, value: p }));
      const models = [];
      
      while (true) {
        const { provider } = await inquirer.prompt([{
          type: 'list', name: 'provider', message: 'Select a provider for the next fallback layer:',
          choices: [...providerChoices, new inquirer.Separator(), { name: '✅ Finish and Save', value: 'finish' }, { name: '❌ Cancel', value: 'cancel' }]
        }]);
        
        if (provider === 'cancel') break;
        if (provider === 'finish') {
          if (models.length > 0) {
            await createCombo({ id: randomUUID(), name, models });
            console.log(chalk.green(`  ✅ Combo "${name}" created with ${models.length} models.\n`));
          } else {
            console.log(chalk.yellow('  ⚠️ Combo not saved (0 models).'));
          }
          break;
        }
        
        const activeConn = conns.find(c => c.provider === provider && c.isActive);
        const sp = spin(`Fetching latest models from ${provider}...`).start();
        const fetchedModels = await fetchProviderModels(provider, activeConn);
        sp.stop();
        
        let providerModels = [];
        const staticModels = getModelsByProviderId(provider);
        
        if (fetchedModels.length > 0) {
          providerModels = fetchedModels.map(fm => {
            const sm = staticModels.find(m => m.id === fm.id);
            return {
              id: fm.id,
              name: sm ? sm.name : fm.name || fm.id,
              type: sm ? sm.type : 'llm'
            };
          }).filter(m => !m.type || m.type === 'llm');
          console.log(chalk.cyan(`  ✨ Successfully loaded ${providerModels.length} models in real-time.`));
        } else {
          providerModels = staticModels.filter(m => !m.type || m.type === 'llm');
          console.log(chalk.gray(`  ⚠️ Could not query dynamic model list. Using offline fallback list.`));
        }

        const docUrl = PROVIDER_DOCS_URLS[provider];
        if (docUrl) {
          console.log(chalk.gray(`  💡 Tip: You can find all models in the official docs: ${docUrl}`));
        }
        
        const baseModelChoices = providerModels.length > 0
          ? providerModels.map(m => ({ name: `${m.id}  ${chalk.gray('— ' + m.name)}`, value: m.id }))
          : [{ name: 'auto', value: 'auto' }];

        const comboModelChoices = [
          ...baseModelChoices,
          new inquirer.Separator(),
          { name: '✍️ Custom Model (type your own)', value: 'custom' },
          { name: '🔙 Back', value: 'back' }
        ];
        
        const modelChoice = await search({
          message: `Select model for ${provider} (${providerModels.length} available):`,
          source: async (term) => {
            if (!term) return comboModelChoices;
            const t = term.toLowerCase();
            return comboModelChoices.filter(c => {
              if (c.value === 'custom' || c.value === 'back') return true;
              if (typeof c.name === 'string') return c.name.toLowerCase().includes(t);
              return false;
            });
          },
          pageSize: 15
        });
        
        if (modelChoice === 'back') continue;
        
        let finalModel = modelChoice;
        if (modelChoice === 'custom') {
          const { customModel } = await inquirer.prompt([{ type: 'input', name: 'customModel', message: 'Enter custom model name (e.g. gpt-4o) (Note: The app may not have the updated models, so please check/verify):' }]);
          if (!customModel) continue;
          finalModel = customModel;
        }
        
        models.push({ provider, model: finalModel });
        console.log(chalk.green(`  ✅ Added ${provider}/${finalModel}. Total in combo: ${models.length}`));
      }
    }

    if (cAction === 'delete') {
      const combos = await getCombos();
      if (combos.length === 0) { console.log(chalk.gray('  No combos.')); continue; }
      const { comboId } = await inquirer.prompt([{
        type: 'list', name: 'comboId', message: 'Delete which combo?',
        choices: [...combos.map(c => ({ name: c.name, value: c.id })), { name: '🔙 Cancel', value: null }],
      }]);
      if (comboId) {
        await deleteCombo(comboId);
        console.log(chalk.green('  ✅ Deleted.\n'));
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  API KEY MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════
async function manageApiKeys() {
  const keys = await getApiKeys();
  console.log(chalk.cyan('\n  ── API Keys (for securing your proxy) ──'));
  if (keys.length === 0) { console.log(chalk.gray('  (none — proxy accepts any key)')); }
  else { keys.forEach(k => console.log(`  • ${k.name || k.id} — ${chalk.gray(k.key?.substring(0, 8) + '...')}`)); }
  console.log('');

  const { kAction } = await inquirer.prompt([{
    type: 'list', name: 'kAction', message: 'API Key Options:',
    choices: [
      { name: '➕ Generate New Key', value: 'create' },
      { name: '🗑️  Delete Key',      value: 'delete' },
      { name: '🔙 Back',             value: 'back' },
    ],
  }]);

  if (kAction === 'create') {
    const { name } = await inquirer.prompt([{ type: 'input', name: 'name', message: 'Key name:', default: 'default' }]);
    const key = `9r-${crypto.randomBytes(24).toString('hex')}`;
    await createApiKey({ id: randomUUID(), name, key });
    console.log(chalk.green(`\n  ✅ API Key created:`));
    console.log(chalk.white.bold(`     ${key}`));
    console.log(chalk.gray(`     Use this as your API key in CLI tools.\n`));
  }

  if (kAction === 'delete') {
    const keys = await getApiKeys();
    if (keys.length === 0) { console.log(chalk.gray('  No keys.')); return; }
    const { keyId } = await inquirer.prompt([{
      type: 'list', name: 'keyId', message: 'Delete which key?',
      choices: [...keys.map(k => ({ name: k.name || k.id, value: k.id })), { name: '🔙 Cancel', value: null }],
    }]);
    if (keyId) {
      await deleteApiKey(keyId);
      console.log(chalk.green('  ✅ Deleted.\n'));
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  SETTINGS MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════
async function manageSettings() {
  const settings = await getSettings();

  const { setting } = await inquirer.prompt([{
    type: 'list', name: 'setting', message: 'Settings:',
    choices: [
      { name: `RTK Token Saver : ${settings.rtkEnabled ? chalk.green('ON') : chalk.red('OFF')}  — Toggle`, value: 'rtk' },
      { name: `Caveman Mode    : ${settings.cavemanEnabled ? chalk.green('ON') : chalk.red('OFF')}  — Toggle`, value: 'caveman' },
      { name: `Caveman Level   : ${chalk.cyan(settings.cavemanLevel || 'full')}  — Change`, value: 'cavemanLevel' },
      { name: `Require API Key : ${settings.requireApiKey ? chalk.green('ON') : chalk.red('OFF')}  — Toggle`, value: 'requireKey' },
      { name: `Debug Logging   : ${settings.debugMode ? chalk.green('ON') : chalk.red('OFF')}  — Toggle`, value: 'debug' },
      new inquirer.Separator(),
      { name: '🔄 Refresh Models (sync live provider model lists)', value: 'refreshModels' },
      { name: '♻️ Reset Models  (back to built-in static list)', value: 'resetModels' },
      new inquirer.Separator(),
      { name: '🔙 Back', value: 'back' },
    ],
    loop: false
  }]);

  if (setting === 'back') return;

  if (setting === 'refreshModels') {
    console.log(chalk.cyan('\n  ⏳ Refreshing provider model lists...\n'));
    const results = await syncProviderModels();
    if (!results.length) {
      console.log(chalk.yellow('  ℹ️ No active connections returned live models. Nothing changed.\n'));
      return;
    }
    for (const r of results) {
      const tag = r.status === 'synced'
        ? chalk.green(`✅ ${r.alias}: ${r.total} models`)
        : chalk.yellow(`⏭️  ${r.alias}: ${r.reason}`);
      console.log(`  ${tag}${r.status === 'synced' ? chalk.gray(`  (+${r.added} / −${r.removed})`) : ''}`);
    }
    console.log(chalk.green('\n  ✅ Model lists refreshed.\n'));
    return;
  }

  if (setting === 'resetModels') {
    const { confirm } = await inquirer.prompt([{
      type: 'confirm', name: 'confirm',
      message: 'Reset model lists to the built-in static config?',
      default: false,
    }]);
    if (!confirm) return;
    await resetSyncedModels();
    console.log(chalk.green('  ✅ Model lists reset to built-in static config.\n'));
    return;
  }

  if (setting === 'cavemanLevel') {
    const { newLevel } = await inquirer.prompt([{
      type: 'list', name: 'newLevel', message: 'Select Caveman Intensity:',
      choices: [
        { name: 'lite (Professional but concise)', value: 'lite' },
        { name: 'full (Drop articles, short fragments)', value: 'full' },
        { name: 'ultra (Extreme abbreviation, telegraphic)', value: 'ultra' }
      ]
    }]);
    await updateSettings({ cavemanLevel: newLevel });
    console.log(chalk.green(`  ✅ Caveman Level set to ${newLevel}\n`));
    return;
  }

  const toggleMap = { rtk: 'rtkEnabled', caveman: 'cavemanEnabled', requireKey: 'requireApiKey', debug: 'debugMode' };
  const key = toggleMap[setting];
  if (key) {
    const newVal = !settings[key];
    await updateSettings({ [key]: newVal });
    console.log(chalk.green(`  ✅ ${key} set to ${newVal ? 'ON' : 'OFF'}\n`));
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  CLI TOOLS CONFIGURATIONS
// ═══════════════════════════════════════════════════════════════════════════
export async function manageCliTools(port) {
  const endpoint = `http://localhost:${port}/v1`;
  const endpointNoV1 = `http://localhost:${port}`;
  
  // Tool adapter factory: one adapter per CLI tool holds all config logic
  function getToolAdapter(tool) {
    switch (tool) {
      case 'claude': return new ClaudeAdapter(false);
      case 'openclaude': return new ClaudeAdapter(true);
      case 'opencode': return new OpenCodeAdapter();
      case 'codex': return new CodexAdapter();
      case 'aider': return new AiderAdapter();
      case 'pi': return new PiAdapter();
      case 'cline': return new ClineAdapter();
      case 'hermes': return new HermesAdapter();
      default: return null;
    }
  }

  // Helper: detect if a tool already has voidRoute config
  function detectStatus(tool) {
    try { return getToolAdapter(tool)?.detectStatus() || null; } catch (e) { return null; }
  }
  
  function label(tool, name) {
    const st = detectStatus(tool);
    return st ? `${name} ${chalk.green('[Connected]')}` : name;
  }
  
  while (true) {
    const { tool } = await inquirer.prompt([{
      type: 'list', name: 'tool', message: 'Select CLI Tool to configure:',
      choices: [
        { name: label('claude', 'Claude Code'), value: 'claude' },
        { name: label('openclaude', 'OpenClaude'), value: 'openclaude' },
        { name: label('opencode', 'OpenCode'), value: 'opencode' },
        { name: label('codex', 'OpenAI Codex'), value: 'codex' },
        { name: label('aider', 'Aider'), value: 'aider' },
        { name: label('pi', 'Pi Agent'), value: 'pi' },
        { name: label('cline', 'Cline'), value: 'cline' },
        { name: label('hermes', 'Hermes Agent'), value: 'hermes' },
        { name: 'Cursor (Manual Guide)', value: 'manual' },
        new inquirer.Separator(),
        { name: '🔙 Back', value: 'back' },
      ],
      loop: false
    }]);

    if (tool === 'back') return;

    // If already connected, offer apply/reset choice
    const status = detectStatus(tool);
    let action = 'apply';
    if (status === 'connected') {
      const { whatDo } = await inquirer.prompt([{
        type: 'list', name: 'whatDo', message: `${tool} is already configured with voidRoute. What do you want to do?`,
        choices: [
          { name: '🔄  Re-apply / Update config', value: 'apply' },
          { name: '🗑️   Remove voidRoute config (reset to defaults)', value: 'reset' },
          { name: '🔙  Cancel', value: 'cancel' },
        ],
      }]);
      if (whatDo === 'cancel') continue;
      action = whatDo;
    }

    console.log(chalk.cyan(`\n  ── ${action === 'reset' ? 'Resetting' : 'Configuring'} ${tool} ──\n`));

    // Ask for target model if applying and not manual
    let selectedModel = 'ag/gemini-2.5-pro';
    let defaultModelForTool = 'ag/gemini-2.5-pro';
    let providerModelsList = [];
    let allModelsForProvider = null;
    let allModelsForPi = true; // Pi Agent registers all by default
    
    if (action === 'apply' && tool !== 'manual') {
      const connections = await getProviderConnections();
      if (connections.length === 0) {
        console.log(chalk.red('  ❌ No providers added yet. Please add a provider first.'));
        continue;
      }
      
      const providerChoices = [
        ...connections.map(c => ({ name: `${c.provider} (${c.name || 'Account'})`, value: c.id })),
        new inquirer.Separator(),
        { name: '🔙 Back', value: 'back' }
      ];
      const { selectedConnId } = await inquirer.prompt([{
        type: 'list', name: 'selectedConnId',
        message: `Which provider do you want to use for ${tool}?`,
        choices: providerChoices,
        loop: false
      }]);
      
      if (selectedConnId === 'back') continue;
      
      const conn = connections.find(c => c.id === selectedConnId);
      
      // Dynamic model fetching with static fallback
      const sp = spin(`Fetching latest models from ${conn.provider}...`).start();
      const fetchedModels = await fetchProviderModels(conn.provider, conn);
      sp.stop();
      
      let modelsForThisProvider = [];
      const { PROVIDER_MODELS } = await import('./open-sse/config/providerModels.js');
      
      if (fetchedModels.length > 0) {
        const alias = (await resolveRoutedPrefix(conn.provider)) || getProviderAlias(conn.provider);
        const staticList = PROVIDER_MODELS[alias] || PROVIDER_MODELS[conn.provider];
        modelsForThisProvider = fetchedModels
          .filter(m => !m.type || m.type === 'llm')
          .map(m => {
            const displayName = staticList
              ? staticList.find(sm => sm.id === m.id)?.name
              : null;
            const fullId = alias ? `${alias}/${m.id}` : m.id;
            return { id: fullId, name: displayName || m.name || m.id };
          });
        console.log(chalk.cyan(`  ✨ Loaded ${modelsForThisProvider.length} models from ${conn.provider} API`));
      } else {
        // Fallback to static model list
        const alias = (await resolveRoutedPrefix(conn.provider)) || getProviderAlias(conn.provider);
        const list = getModelsByProviderId(conn.provider) || PROVIDER_MODELS[alias] || PROVIDER_MODELS[conn.provider];
        if (list) {
          for (const m of list) {
            const fullId = alias ? `${alias}/${m.id || m}` : (m.id || m);
            modelsForThisProvider.push({ id: fullId, name: m.name || fullId });
          }
        }
        console.log(chalk.gray(`  ℹ️  Using static model list (${modelsForThisProvider.length} models)`));
      }

      providerModelsList = modelsForThisProvider;
      
      // Build model choices — always include manual entry option
      const modelChoices = [
        ...modelsForThisProvider.map(m => ({ 
          name: m.name && m.name !== m.id ? `${m.id} — ${m.name}` : m.id, 
          value: m.id 
        })),
        new inquirer.Separator(),
        { name: '🖊️  Enter custom model manually...', value: '__custom__' },
        { name: '🔙 Back', value: 'back' },
      ];
      
      const chosenModel = await search({
        message: `Select the default model to use for ${tool}:`,
        source: async (term) => {
          if (!term) return modelChoices;
          const t = term.toLowerCase();
          return modelChoices.filter(c => {
            if (c.value === '__custom__' || c.value === 'back') return true;
            if (typeof c.name === 'string') return c.name.toLowerCase().includes(t);
            return false;
          });
        },
        pageSize: 15,
      });
      
      if (chosenModel === 'back') continue;
      
      if (chosenModel === '__custom__') {
        const { customModel } = await inquirer.prompt([{
          type: 'input', name: 'customModel', 
          message: 'Enter model ID (e.g., ag/gemini-2.5-pro or openai/gpt-4o):'
        }]);
        selectedModel = customModel;
      } else {
        selectedModel = chosenModel;
      }
      
      defaultModelForTool = selectedModel;

      // OpenCode, Pi Agent & Codex: offer to register ALL models from the provider
      if (chosenModel !== '__custom__' && providerModelsList.length > 1) {
        if (tool === 'opencode') {
          const { useAll } = await inquirer.prompt([{
            type: 'confirm', name: 'useAll',
            message: `Register ALL ${providerModelsList.length} models from this provider? (OpenCode supports multi-model configs)`,
            default: false,
          }]);
          if (useAll) {
            allModelsForProvider = providerModelsList.map(m => m.id);
            defaultModelForTool = providerModelsList[0]?.id || selectedModel;
          }
        } else if (tool === 'pi') {
          const { useAll } = await inquirer.prompt([{
            type: 'confirm', name: 'useAll',
            message: `Register ALL ${providerModelsList.length} models from this provider? (Pi Agent supports multi-model configs)`,
            default: true,
          }]);
          allModelsForPi = useAll;
        } else if (tool === 'codex') {
          // OpenCodex multi-model: register the SELECTED provider's models only
          // (the Codex picker is the only model picker).
          const { registerMode } = await inquirer.prompt([{
            type: 'list', name: 'registerMode',
            message: `How would you like to configure models for Codex? (OpenCodex Multi-Model Proxy)`,
            choices: [
              { name: `📦 Register ALL ${providerModelsList.length} models from this provider`, value: 'this_provider' },
              { name: `🎯 Register only selected default model (${selectedModel})`, value: 'single' },
            ],
            default: 'this_provider',
          }]);
          if (registerMode === 'this_provider') {
            allModelsForProvider = providerModelsList.map(m => m.id);
            defaultModelForTool = providerModelsList[0]?.id || selectedModel;
          } else {
            allModelsForProvider = [selectedModel];
          }
        }
      }
    }

    // ──── CLAUDE CODE & OPENCLAUDE ─────────────────────────────────────────
    if (tool === 'claude' || tool === 'openclaude') {
      const adapter = getToolAdapter(tool);
      if (action === 'reset') {
        adapter.resetConfig();
      } else {
        adapter.applyConfig(selectedModel, endpoint, endpointNoV1);
      }
    }
    // ──── OPENCODE ────────────────────────────────────────────────────────
    else if (tool === 'opencode') {
      const adapter = getToolAdapter(tool);
      if (action === 'reset') {
        adapter.resetConfig();
      } else {
        await adapter.applyConfig(selectedModel, endpoint, endpointNoV1, providerModelsList, allModelsForProvider, defaultModelForTool);
      }
    }
    // ──── CODEX ───────────────────────────────────────────────────────────
    else if (tool === 'codex') {
      const adapter = getToolAdapter(tool);
      if (action === 'reset') {
        adapter.resetConfig();
      } else {
        adapter.applyConfig(selectedModel, endpoint, endpointNoV1, providerModelsList, allModelsForProvider, defaultModelForTool);
      }
    }
    // ──── AIDER ───────────────────────────────────────────────────────────
    else if (tool === 'aider') {
      const adapter = getToolAdapter(tool);
      if (action === 'reset') {
        adapter.resetConfig();
      } else {
        adapter.applyConfig(selectedModel, endpoint, endpointNoV1);
      }
    }
    // ──── PI AGENT ────────────────────────────────────────────────────────
    else if (tool === 'pi') {
      const adapter = getToolAdapter(tool);
      if (action === 'reset') {
        adapter.resetConfig();
      } else {
        adapter.applyConfig(selectedModel, endpoint, endpointNoV1, providerModelsList, allModelsForProvider, defaultModelForTool, allModelsForPi);
      }
    }
    // ──── CLINE ───────────────────────────────────────────────────────────
    else if (tool === 'cline') {
      const adapter = getToolAdapter(tool);
      if (action === 'reset') {
        adapter.resetConfig();
      } else {
        adapter.applyConfig(selectedModel, endpoint, endpointNoV1);
      }
    }
    // ──── HERMES AGENT ─────────────────────────────────────────────────────
    else if (tool === 'hermes') {
      const adapter = getToolAdapter(tool);
      if (action === 'reset') {
        adapter.resetConfig();
      } else {
        adapter.applyConfig(
          selectedModel,
          endpoint,
          endpointNoV1,
          providerModelsList,
          allModelsForProvider || providerModelsList.map((m) => m.id),
          defaultModelForTool || selectedModel
        );
      }
    }
    // ──── CURSOR (MANUAL) ─────────────────────────────────────────────────
    else if (tool === 'manual') {
      console.log(chalk.white('  In Cursor:'));
      console.log(chalk.gray('  1. Go to Settings → Models'));
      console.log(chalk.gray('  2. Enable "OpenAI API key" option'));
      console.log(chalk.gray('  3. Set the Base URL to:'));
      console.log(chalk.yellow(`     ${endpoint}`));
      console.log(chalk.gray('  4. Set API Key to any dummy value (e.g. sk_voidRoute)'));
      console.log(chalk.gray('  5. Click "View All Model" → "Add Custom Model"'));
      console.log(chalk.gray('  6. Add model names like "ag/gemini-2.5-pro" or "gh/gpt-4o"'));
    }
    
    console.log('');
    const { next } = await inquirer.prompt([{ type: 'input', name: 'next', message: 'Press Enter to continue...' }]);
  }
}
