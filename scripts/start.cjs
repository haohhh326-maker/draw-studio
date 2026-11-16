const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { probe } = require('./local-supervisor.cjs');

const root = path.resolve(__dirname, '..');
const url = 'http://127.0.0.1:1420/';
const logDir = path.join(root, '.cache');
const noOpen = process.argv.includes('--no-open');
const rebuild = process.argv.includes('--rebuild');

function npm(args) {
  const result = spawnSync('npm.cmd', args, { cwd: root, stdio: 'inherit', shell: true, windowsHide: true });
  if (result.error || result.status !== 0) throw new Error(`npm ${args.join(' ')} failed.`);
}

async function main() {
  let state = await probe(url);
  if (state === 'occupied') throw new Error('Port 1420 belongs to another service. Close that service and retry.');
  if (!fs.existsSync(path.join(root, 'node_modules/vite/bin/vite.js'))) npm(['ci']);
  if (rebuild || !fs.existsSync(path.join(root, 'dist/index.html'))) npm(['run', 'build']);
  if (process.platform === 'win32') {
    const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
    const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-File', path.join(root, 'scripts/local-service.ps1'), '-Action', 'Ensure', '-NodePath', process.execPath], { cwd: root, windowsHide: true, encoding: 'utf8' });
    if (result.error || result.status !== 0) throw new Error(result.stderr?.trim() || result.error?.message || 'The independent canvas service could not start.');
    const report = JSON.parse(result.stdout.replace(/^\uFEFF/, '').trim());
    if (!report.supervisorPid) throw new Error(`The independent canvas service did not start. See ${logDir}/local-service.log`);
  } else if (state !== 'ready') {
    fs.mkdirSync(logDir, { recursive: true });
    const stdout = fs.openSync(path.join(logDir, 'preview.stdout.log'), 'a');
    const stderr = fs.openSync(path.join(logDir, 'preview.stderr.log'), 'a');
    const child = spawn(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), 'preview', '--host', '127.0.0.1', '--port', '1420', '--strictPort'], {
      cwd: root, detached: true, windowsHide: true, stdio: ['ignore', stdout, stderr],
    });
    child.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
    child.unref();
    fs.closeSync(stdout);
    fs.closeSync(stderr);
  }
  for (let attempt = 0; attempt < 40; attempt++) {
    state = await probe(url);
    if (state === 'ready') break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (state !== 'ready') throw new Error(`Canvas did not start (${state}). See ${logDir}/preview.stderr.log`);
  console.log(`Canvas is ready: ${url}\nThe Windows background service recovers after preview exits and starts when you sign in.`);
  if (!noOpen) {
    const opener = spawn('powershell.exe', ['-NoProfile', '-Command', `Start-Process '${url}'`], { windowsHide: true, stdio: 'ignore' });
    opener.on('error', () => console.log(`Open ${url} in your browser.`));
  }
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
