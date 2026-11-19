// Exercise the compiled Node entry point, HTTP health, metrics, Origin checks, and SIGTERM.
import assert from 'node:assert/strict'; // Make a mismatch fail with a short, direct message.
import { spawn } from 'node:child_process'; // Run the same compiled file Docker will execute.
import { once } from 'node:events'; // Await the server, client, and process lifecycle.
import { mkdtemp, rm } from 'node:fs/promises'; // Keep room replay logs outside the project.
import { tmpdir } from 'node:os'; // Use the operating system's temporary folder.
import path from 'node:path'; // Build temporary paths on Windows and Linux.
import net from 'node:net'; // Reserve an available loopback port.
import WebSocket from 'ws'; // Verify the real WebSocket handshake and shutdown frame.

// Find an available port and release it immediately before starting Node.
async function reservePort() {
  const listener = net.createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const address = listener.address();
  if (!address || typeof address === 'string') throw new Error('Could not reserve a TCP port');
  await new Promise((resolve, reject) => listener.close((error) => (error ? reject(error) : resolve())));
  return address.port;
}

// Wait for one protocol message while ignoring room roster and snapshot frames.
function waitForType(socket, type, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('message', onMessage);
      reject(new Error('Timed out waiting for ' + type));
    }, timeoutMs);
    function onMessage(raw, isBinary) {
      if (isBinary) return;
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (message.type !== type) return;
      clearTimeout(timer);
      socket.off('message', onMessage);
      resolve(message);
    }
    socket.on('message', onMessage);
  });
}

// Capture an HTTP rejection from an untrusted WebSocket Origin.
function rejectedStatus(url, origin) {
  const socket = new WebSocket(url, { headers: { Origin: origin } });
  return new Promise((resolve, reject) => {
    socket.once('unexpected-response', (_request, response) => resolve(response.statusCode));
    socket.once('error', reject);
  });
}

const port = await reservePort();
const logsDirectory = await mkdtemp(path.join(tmpdir(), 'asteroids-lab8-production-'));
const child = spawn(process.execPath, ['server/dist/server/src/index.js'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    NODE_ENV: 'production',
    PORT: String(port),
    HOST: '127.0.0.1',
    LOG_DIR: logsDirectory,
    ALLOWED_ORIGINS: 'http://localhost:3000',
    MAX_CONNECTIONS_PER_IP: '1',
    BUILD_SHA: 'production-smoke-sha',
    BUILD_VERSION: 'lab-08-smoke',
    ENABLE_DEMOS: 'false',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let stdout = ''; // Keep structured output for a final check without printing secrets or full traffic.
child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => (stdout += chunk));
child.stderr.resume(); // Drain diagnostics so an error cannot block the process pipe.
let socket = null; // Keep an open participant available to the shutdown step.
let finished = false; // Track whether the child already exited before cleanup.

try {
  const baseUrl = 'http://127.0.0.1:' + port;
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error('Production server exited with code ' + child.exitCode);
    try {
      const response = await fetch(baseUrl + '/ready');
      if (response.ok) {
        ready = true;
        break;
      }
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  assert.equal(ready, true, 'Production server did not become ready');

  // Check that the build identity, observability endpoint, and install metadata are served.
  const health = await fetch(baseUrl + '/health').then((response) => response.json());
  assert.equal(health.gitSha, 'production-smoke-sha');
  assert.equal(health.version, 'lab-08-smoke');
  const metrics = await fetch(baseUrl + '/metrics').then((response) => response.json());
  for (const key of [
    'connectedPlayers',
    'rooms',
    'messagesInPerSecond',
    'bytesOutPerSecond',
    'tickDurationP99Ms',
    'eventLoopUtilization',
    'rssBytes',
  ]) {
    assert.ok(key in metrics, 'Missing /metrics field: ' + key);
  }
  const manifestResponse = await fetch(baseUrl + '/manifest.webmanifest');
  assert.equal(manifestResponse.status, 200);
  const manifest = await manifestResponse.json();
  for (const size of [192, 512]) {
    const iconEntry = manifest.icons.find((icon) => icon.sizes === size + 'x' + size && icon.type === 'image/png');
    assert.ok(iconEntry, 'PWA manifest is missing its ' + size + ' pixel PNG icon');
    const iconResponse = await fetch(baseUrl + iconEntry.src);
    assert.equal(iconResponse.status, 200);
    const png = Buffer.from(await iconResponse.arrayBuffer());
    assert.equal(png.readUInt32BE(16), size, 'PWA icon width does not match its manifest size');
    assert.equal(png.readUInt32BE(20), size, 'PWA icon height does not match its manifest size');
  }
  assert.equal((await fetch(baseUrl + '/sw.js')).status, 200);
  const websocketUrl = 'ws://127.0.0.1:' + port + '/ws';
  assert.equal(await rejectedStatus(websocketUrl, 'https://untrusted.example'), 403);

  // Join one live room so shutdown has a real participant and match log to close.
  socket = new WebSocket('ws://127.0.0.1:' + port + '/ws', {
    headers: { Origin: 'http://localhost:3000' },
  });
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  const joined = waitForType(socket, 'joined_success');
  socket.send(JSON.stringify({ v: 1, type: 'join', room: 'default_room', name: 'Smoke player', format: 'json' }));
  await joined;
  assert.equal(await rejectedStatus(websocketUrl, 'http://localhost:3000'), 429); // A second socket from the same IP exceeds the configured cap.
  const activeMetrics = await fetch(baseUrl + '/metrics').then((response) => response.json());
  assert.equal(activeMetrics.connectedPlayers, 1);
  assert.equal(activeMetrics.rejectedConnections.ip_limit, 1);
  let shutdownResult = { check: 'skipped on Windows; Docker CI checks SIGTERM on Linux' };
  if (process.platform !== 'win32') {
    const shutdownNotice = waitForType(socket, 'shutdown', 8000);
    const closeEvent = once(socket, 'close');
    const exitEvent = once(child, 'exit');
    const startedAt = Date.now();
    child.kill('SIGTERM'); // The compiled Node entry point must handle this as the container will.
    const [message, [closeCode, closeReason], [exitCode, signal]] = await Promise.all([
      shutdownNotice,
      closeEvent,
      exitEvent,
    ]);
    finished = true;
    const elapsedMs = Date.now() - startedAt;
    assert.equal(message.type, 'shutdown');
    assert.equal(closeCode, 1001);
    assert.equal(exitCode, 0);
    assert.equal(signal, null);
    assert.ok(elapsedMs < 10_000, 'SIGTERM cleanup exceeded ten seconds');
    shutdownResult = { notice: message.type, closeCode, exitCode, elapsedMs, closeReason: closeReason.toString() };
    if (!child.stdout.readableEnded) await once(child.stdout, 'end'); // Drain final Pino records after the process exit.
  } else {
    await new Promise((resolve) => setTimeout(resolve, 100)); // Let the captured join event reach stdout on Windows.
  }

  // Parse Pino's stdout and confirm the join event carries the required entity IDs.
  const records = stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const joinedLog = records.find((record) => record.msg === 'player joined room');
  assert.ok(joinedLog?.roomId && joinedLog?.playerId, 'Pino join log did not include roomId and playerId');
  console.log(JSON.stringify({ ready, originRejected: 403, shutdown: shutdownResult }));
} finally {
  socket?.terminate(); // Release a client left open after any failed check.
  if (!finished && child.exitCode === null && child.signalCode === null) {
    const exitEvent = once(child, 'exit'); // Catch the process exit before requesting cleanup.
    child.kill(process.platform === 'win32' ? 'SIGINT' : 'SIGTERM'); // Windows cannot deliver POSIX SIGTERM semantics to a child process.
    let forceTimer;
    await Promise.race([
      exitEvent,
      new Promise((resolve) => {
        forceTimer = setTimeout(resolve, 3000); // Bound cleanup even if the child ignores a signal.
      }),
    ]);
    if (forceTimer) clearTimeout(forceTimer);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); // Force-stop only a failed smoke-test child.
  }
  await rm(logsDirectory, { recursive: true, force: true }); // Remove temporary match logs after Pino and replay streams close.
}
