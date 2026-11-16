const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const crypto = require('node:crypto');
const os = require('node:os');
const { spawn } = require('node:child_process');

// Keep the entire request bounded, including a server that never ends its body.
function request(url, timeoutMs, prefixBytes = 0) {
  return new Promise((resolve) => {
    let finished = false;
    let req;
    const finish = (result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      req?.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    req = http.get(url, (response) => {
      let size = 0;
      const chunks = [];
      const limit = prefixBytes || 1024 * 1024;
      const result = () => ({ status: response.statusCode, type: response.headers['content-type'] ?? '', body: Buffer.concat(chunks).toString('utf8') });
      response.on('data', (chunk) => {
        if (finished) return;
        const remaining = limit - size;
        if (!prefixBytes && chunk.length > remaining) { finish(null); return; }
        const retained = chunk.subarray(0, remaining);
        chunks.push(retained);
        size += retained.length;
        // An entry bundle can grow without making its serving process unhealthy.
        // Inspect only a bounded prefix, then close this probe's connection.
        if (prefixBytes && size >= limit) finish(result());
      });
      response.on('end', () => finish(result()));
      response.on('error', () => finish(null));
    });
    req.on('error', () => finish(null));
  });
}

async function probe(url, timeoutMs = 2000) {
  const document = await request(url, timeoutMs);
  if (!document) return 'offline';
  if (document.status !== 200 || !/<title>\s*(Draw studio|AI Infinite Canvas)\s*<\/title>/i.test(document.body)) return 'occupied';
  const scripts = document.body.match(/<script\b[^>]*>/gi) ?? [];
  const module = scripts.find((tag) => /\btype\s*=\s*["']module["']/i.test(tag));
  const source = module?.match(/\bsrc\s*=\s*["']([^"']+)["']/i)?.[1];
  if (!source) return 'unhealthy';
  let entry;
  try { entry = new URL(source, url); }
  catch { return 'unhealthy'; }
  if (entry.origin !== new URL(url).origin || entry.username || entry.password) return 'unhealthy';
  const asset = await request(entry, timeoutMs, 64 * 1024);
  return asset?.status === 200 && /(?:java|ecma)script/i.test(asset.type) && /^\s*[^\s<]/.test(asset.body) ? 'ready' : 'unhealthy';
}

function supervisorEndpoint(root) {
  const id = crypto.createHash('sha256').update(fs.realpathSync(root).toLowerCase()).digest('hex').slice(0, 20);
  return process.platform === 'win32' ? `\\\\.\\pipe\\draw-studio-canvas-${id}` : path.join(os.tmpdir(), `draw-studio-canvas-${id}.sock`);
}

function createSupervisor(options = {}) {
  const root = fs.realpathSync(options.root ?? path.resolve(__dirname, '..'));
  const url = options.url ?? 'http://127.0.0.1:1420/';
  const intervalMs = options.intervalMs ?? 3000;
  const cache = path.join(root, '.cache');
  const statusFile = path.join(cache, 'local-service-status.json');
  const disabled = path.join(cache, 'local-service.disabled');
  const vite = path.join(root, 'node_modules/vite/bin/vite.js');
  const address = new URL(url);
  const serverArgs = options.serverArgs ?? [vite, 'preview', '--host', '127.0.0.1', '--port', address.port || '1420', '--strictPort'];
  let server;
  let lock;
  let active = false;
  let timer;
  let stopping = false;
  let startedAt = 0;
  let failedChecks = 0;
  let restartAttempts = 0;
  let nextStartAt = 0;
  let status = { supervisorPid: process.pid, serverPid: null, ownsServer: false, root, url, phase: 'starting', updatedAt: new Date().toISOString() };
  fs.mkdirSync(cache, { recursive: true });

  function log(message) {
    const file = path.join(cache, 'local-service.log');
    if (fs.existsSync(file) && fs.statSync(file).size > 5 * 1024 * 1024) fs.renameSync(file, `${file}.previous`);
    fs.appendFileSync(file, `${new Date().toISOString()} ${message}\n`);
  }
  function publish(phase) {
    if (status.phase !== phase) log(`State: ${phase}`);
    status = { ...status, phase, serverPid: server?.pid ?? null, ownsServer: Boolean(server), updatedAt: new Date().toISOString() };
    const temporary = `${statusFile}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(status, null, 2));
    fs.renameSync(temporary, statusFile);
  }
  function startServer() {
    const stdout = fs.openSync(path.join(cache, 'preview.stdout.log'), 'a');
    const stderr = fs.openSync(path.join(cache, 'preview.stderr.log'), 'a');
    try {
      const child = spawn(options.nodePath ?? process.execPath, serverArgs, { cwd: root, windowsHide: true, stdio: ['ignore', stdout, stderr], env: { ...process.env, ...options.env } });
      server = child;
      startedAt = Date.now();
      failedChecks = 0;
      log(`Started preview PID ${child.pid ?? 'pending'}`);
      child.on('error', (error) => log(`Preview start failed: ${error.message}`));
      child.on('close', (code, signal) => {
        if (server !== child) return;
        server = undefined;
        restartAttempts += 1;
        nextStartAt = Date.now() + Math.min(30000, 1000 * 2 ** Math.min(restartAttempts - 1, 5));
        log(`Preview exited (${code ?? signal}); retry after ${nextStartAt - Date.now()}ms`);
        if (!stopping) publish('recovering');
      });
      publish('starting');
    } finally {
      fs.closeSync(stdout);
      fs.closeSync(stderr);
    }
  }
  async function stop() {
    if (stopping || !active) return;
    stopping = true;
    clearTimeout(timer);
    if (server) {
      const child = server;
      await new Promise((resolve) => { child.once('close', resolve); child.kill(); });
    }
    if (lock) await new Promise((resolve) => lock.close(resolve));
    publish('stopped');
    if (process.platform !== 'win32' && fs.existsSync(supervisorEndpoint(root))) fs.unlinkSync(supervisorEndpoint(root));
  }
  async function tick() {
    if (stopping) return;
    if (fs.existsSync(disabled)) { await stop(); return; }
    const state = await probe(url, options.timeoutMs ?? 2000);
    if (stopping || fs.existsSync(disabled)) { await stop(); return; }
    if (state === 'ready') {
      restartAttempts = 0;
      failedChecks = 0;
      publish(server ? 'ready' : 'monitoring');
    } else if (server) {
      failedChecks += 1;
      publish('recovering');
      // Only terminate the child this supervisor created; never an adopted service.
      if (Date.now() - startedAt > (options.startupGraceMs ?? 15000) && failedChecks >= 3) server.kill();
    } else if (state === 'offline') {
      if (Date.now() >= nextStartAt) startServer();
      else publish('recovering');
    } else {
      publish(state); // A foreign service is left alone, including on port 1420.
    }
    if (!stopping) timer = setTimeout(() => tick().catch(fatal), intervalMs);
  }
  function fatal(error) {
    log(`Supervisor failed: ${error.stack ?? error}`);
    process.exitCode = 1;
    stop().catch(() => { process.exitCode = 1; });
  }
  async function start() {
    if (fs.existsSync(disabled)) return false;
    lock = net.createServer((socket) => socket.destroy());
    const acquired = await new Promise((resolve, reject) => {
      lock.once('error', (error) => error.code === 'EADDRINUSE' ? resolve(false) : reject(error));
      lock.listen(supervisorEndpoint(root), () => resolve(true));
    });
    if (!acquired) return false;
    active = true;
    log(`Supervisor PID ${process.pid} started at ${root}`);
    publish('starting');
    await tick();
    return true;
  }
  return { start, stop, getStatus: () => ({ ...status }) };
}

module.exports = { probe, supervisorEndpoint, createSupervisor };
if (require.main === module && process.argv[2] === '--print-root') {
  process.stdout.write(fs.realpathSync(process.argv[3] ?? path.resolve(__dirname, '..')));
} else if (require.main === module) {
  const supervisor = createSupervisor();
  process.on('SIGINT', () => supervisor.stop());
  process.on('SIGTERM', () => supervisor.stop());
  supervisor.start().catch((error) => { console.error(error); process.exitCode = 1; });
}
