import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const PATCH_VERSION = 1;
const PACKAGE_PREFIX = 'OpenAI.Codex_';
const TARGET_ENTRY_PATTERN = /^\/webview\/assets\/app-initial-[^/]+\.js$/;
const OLD_ALLOWLIST_EXPRESSION = Buffer.from('?n.has(r.model):!r.hidden');
const NEW_ALLOWLIST_EXPRESSION = Buffer.from('?(!r.hidden):!r.hidden   ');

function usage() {
  console.log([
    'Usage:',
    '  bun run tools/patch-codex-desktop.mjs [--launch]',
    '',
    'Options:',
    '  --launch             Launch the patched Desktop copy after patching.',
    '  --source <directory> Use an explicit Windows Codex package directory.',
    '  --destination <dir> Use an explicit output package directory.',
    '  --data-dir <dir>     Use an explicit Electron user-data directory.',
  ].join('\n'));
}

function parseArgs(argv) {
  const options = { launch: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') {
      usage();
      process.exit(0);
    }
    if (argument === '--launch') {
      options.launch = true;
      continue;
    }
    if (['--source', '--destination', '--data-dir'].includes(argument)) {
      const value = argv[index + 1];
      if (!value) throw new Error(`${argument} requires a path`);
      const optionName = argument === '--data-dir' ? 'dataDir' : argument.slice(2);
      options[optionName] = path.resolve(value);
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

function versionParts(packageName) {
  const match = packageName.match(/^OpenAI\.Codex_(\d+(?:\.\d+)+)_x64__/i);
  return match ? match[1].split('.').map(Number) : [];
}

function compareVersions(left, right) {
  const a = versionParts(left);
  const b = versionParts(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] || 0) - (b[index] || 0);
    if (difference !== 0) return difference;
  }
  return left.localeCompare(right);
}

function findInstalledPackage() {
  const windowsApps = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'WindowsApps');
  const candidates = [];
  const appxResult = spawnSync('powershell.exe', [
    '-NoProfile',
    '-Command',
    "(Get-AppxPackage -Name 'OpenAI.Codex').InstallLocation",
  ], { encoding: 'utf8' });
  if (appxResult.status === 0) {
    for (const value of String(appxResult.stdout || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean)) {
      if (value.startsWith(windowsApps) && fs.existsSync(path.join(value, 'app', 'ChatGPT.exe'))) candidates.push(value);
    }
  }
  if (candidates.length === 0) {
    try {
      candidates.push(...fs.readdirSync(windowsApps, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name.startsWith(PACKAGE_PREFIX))
        .map((entry) => path.join(windowsApps, entry.name))
        .filter((directory) => fs.existsSync(path.join(directory, 'app', 'ChatGPT.exe'))));
    } catch {
      // Windows Store ACLs can deny directory enumeration; Get-AppxPackage is the supported path.
    }
  }
  candidates.sort((left, right) => compareVersions(path.basename(right), path.basename(left)));
  if (candidates.length === 0) {
    throw new Error(`No installed OpenAI Codex Desktop package found under ${windowsApps}`);
  }
  return candidates[0];
}

function flattenAsarEntries(files, prefix = '') {
  const entries = [];
  for (const [name, entry] of Object.entries(files || {})) {
    const filePath = `${prefix}/${name}`;
    if (entry.files) entries.push(...flattenAsarEntries(entry.files, filePath));
    else entries.push({ filePath, entry });
  }
  return entries;
}

function readAsar(archive) {
  if (archive.length < 16 || archive.readUInt32LE(0) !== 4) {
    throw new Error('Unsupported ASAR header');
  }
  const headerLength = archive.readUInt32LE(12);
  const headerStart = 16;
  const headerEnd = headerStart + headerLength;
  if (headerEnd > archive.length) throw new Error('ASAR header exceeds archive length');
  return {
    headerLength,
    headerStart,
    headerEnd,
    header: JSON.parse(archive.subarray(headerStart, headerEnd).toString('utf8')),
  };
}

function hash(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function replaceAllBytes(buffer, oldValue, newValue) {
  if (oldValue.length !== newValue.length) throw new Error('ASAR replacement must preserve byte length');
  let count = 0;
  let offset = buffer.indexOf(oldValue);
  while (offset >= 0) {
    newValue.copy(buffer, offset);
    count += 1;
    offset = buffer.indexOf(oldValue, offset + newValue.length);
  }
  return count;
}

function patchAsar(sourcePath, destinationPath) {
  const source = fs.readFileSync(sourcePath);
  const sourceInfo = readAsar(source);
  const candidates = flattenAsarEntries(sourceInfo.header.files)
    .filter(({ filePath }) => TARGET_ENTRY_PATTERN.test(filePath));
  const target = candidates.find(({ entry }) => {
    const start = sourceInfo.headerEnd + Number(entry.offset);
    const content = source.subarray(start, start + entry.size);
    return content.includes(OLD_ALLOWLIST_EXPRESSION) || content.includes(NEW_ALLOWLIST_EXPRESSION);
  });
  if (!target) {
    throw new Error('Unsupported Codex Desktop bundle: model picker allowlist expression was not found');
  }

  const output = Buffer.from(source);
  const contentStart = sourceInfo.headerEnd + Number(target.entry.offset);
  const contentEnd = contentStart + target.entry.size;
  const content = output.subarray(contentStart, contentEnd);
  const oldOffset = content.indexOf(OLD_ALLOWLIST_EXPRESSION);
  if (oldOffset >= 0) {
    if (content.indexOf(OLD_ALLOWLIST_EXPRESSION, oldOffset + 1) >= 0) {
      throw new Error('Model picker allowlist expression is not unique');
    }
    NEW_ALLOWLIST_EXPRESSION.copy(content, oldOffset);
  } else if (!content.includes(NEW_ALLOWLIST_EXPRESSION)) {
    throw new Error('Model picker archive is neither unpatched nor already patched');
  }

  const newHash = hash(content);
  const oldHash = target.entry.integrity?.hash;
  if (typeof oldHash !== 'string' || oldHash.length !== newHash.length) {
    throw new Error('Codex Desktop ASAR integrity metadata is unavailable');
  }
  const header = output.subarray(sourceInfo.headerStart, sourceInfo.headerEnd);
  const replacedHashes = replaceAllBytes(header, Buffer.from(oldHash), Buffer.from(newHash));
  if (replacedHashes === 0) throw new Error('Codex Desktop ASAR integrity hash was not found');

  fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
  fs.writeFileSync(destinationPath, output);
  const verification = readAsar(output);
  const verificationTarget = flattenAsarEntries(verification.header.files)
    .find(({ filePath }) => filePath === target.filePath);
  const verificationStart = verification.headerEnd + Number(verificationTarget.entry.offset);
  const verificationContent = output.subarray(verificationStart, verificationStart + verificationTarget.entry.size);
  if (!verificationContent.includes(NEW_ALLOWLIST_EXPRESSION)
      || verificationContent.includes(OLD_ALLOWLIST_EXPRESSION)
      || verificationTarget.entry.integrity?.hash !== newHash) {
    throw new Error('Patched ASAR verification failed');
  }
  return {
    target: target.filePath,
    oldHash,
    newHash,
    replacedHashes,
    alreadyPatched: oldOffset < 0,
  };
}

function copyPackage(sourceDirectory, destinationDirectory) {
  fs.mkdirSync(path.dirname(destinationDirectory), { recursive: true });
  if (process.platform === 'win32') {
    const result = spawnSync('robocopy', [
      sourceDirectory,
      destinationDirectory,
      '/E',
      '/NFL',
      '/NDL',
      '/NJH',
      '/NJS',
      '/NP',
    ], { stdio: 'inherit' });
    if (result.error) throw result.error;
    if ((result.status ?? 16) > 7) throw new Error(`robocopy failed with exit code ${result.status}`);
    return;
  }
  fs.cpSync(sourceDirectory, destinationDirectory, { recursive: true, force: true });
}

function launchPatchedDesktop(packageDirectory, dataDirectory) {
  const executable = path.join(packageDirectory, 'app', 'ChatGPT.exe');
  fs.mkdirSync(dataDirectory, { recursive: true });
  const child = spawn(executable, [`--user-data-dir=${dataDirectory}`], {
    cwd: path.join(packageDirectory, 'app'),
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  });
  child.unref();
  return child.pid;
}

function canReusePatchedCopy(destination, sourcePackage) {
  const infoPath = path.join(destination, 'voidRoute-patch-info.json');
  const asarPath = path.join(destination, 'app', 'resources', 'app.asar');
  if (!fs.existsSync(infoPath) || !fs.existsSync(asarPath)) return false;
  try {
    const info = JSON.parse(fs.readFileSync(infoPath, 'utf8'));
    return info.patchVersion === PATCH_VERSION && info.sourcePackage === sourcePackage;
  } catch {
    return false;
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (process.platform !== 'win32') throw new Error('The Codex Desktop patcher currently supports Windows only');
  const sourcePackage = options.source || findInstalledPackage();
  const packageName = path.basename(sourcePackage);
  const localRoot = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'voidRoute', 'codex-desktop-patched');
  const destination = options.destination || path.join(localRoot, packageName);
  const sourceAsar = path.join(sourcePackage, 'app', 'resources', 'app.asar');
  const destinationAsar = path.join(destination, 'app', 'resources', 'app.asar');

  const reused = canReusePatchedCopy(destination, sourcePackage);
  if (!reused) copyPackage(sourcePackage, destination);
  const patch = patchAsar(sourceAsar, destinationAsar);
  const infoPath = path.join(destination, 'voidRoute-patch-info.json');
  fs.writeFileSync(infoPath, `${JSON.stringify({
    patchVersion: PATCH_VERSION,
    sourcePackage,
    destination,
    patchedAt: new Date().toISOString(),
    ...patch,
  }, null, 2)}\n`);

  console.log(`Patched Codex Desktop copy: ${destination}`);
  if (reused) console.log('Reused the existing copy for this installed Codex version.');
  console.log(`Patched picker bundle: ${patch.target}`);
  console.log(`Original installation was not modified.`);
  if (options.launch) {
    const dataDirectory = options.dataDir || path.join(destination, 'user-data');
    const pid = launchPatchedDesktop(destination, dataDirectory);
    console.log(`Launched patched Desktop copy, PID ${pid}, data: ${dataDirectory}`);
  }
}

try {
  main();
} catch (error) {
  console.error(`Codex Desktop patch failed: ${error.message}`);
  process.exitCode = 1;
}
