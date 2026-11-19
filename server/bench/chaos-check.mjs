// This local check disconnects one room with malformed traffic and watches another room continue.
import assert from 'node:assert/strict'; // Stop with a useful failure when an isolation condition is missed.
import { spawn } from 'node:child_process'; // Start the actual server instead of a mock.
import { once } from 'node:events'; // Await process, listener, and WebSocket lifecycle events.
import { mkdtemp, rm } from 'node:fs/promises'; // Keep match logs outside the repository and remove them afterward.
import { tmpdir } from 'node:os'; // Store temporary logs in the operating system's temp directory.
import path from 'node:path'; // Build a portable temporary directory name.
import net from 'node:net'; // Reserve a free local TCP port for the child process.
import WebSocket from 'ws'; // Use the same RFC 6455 transport as browser clients.

// Reserve a port briefly so the server can bind to a port that was free at test start.
async function reservePort() {
  const listener = net.createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const address = listener.address();
  if (!address || typeof address === 'string') throw new Error('Could not reserve a TCP port');
  await new Promise((resolve, reject) => listener.close((error) => (error ? reject(error) : resolve())));
  return address.port;
}

// Resolve a protocol message by type without confusing it with unrelated snapshots.
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

// Start one isolated server process with explicit production-like safety settings.
const port = await reservePort();
const logDirectory = await mkdtemp(path.join(tmpdir(), 'asteroids-lab8-chaos-'));
const child = spawn(process.execPath, ['--require', './test-preload.cjs', '--import', 'tsx', 'server/src/index.ts'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    PORT: String(port),
    HOST: '127.0.0.1',
    LOG_DIR: logDirectory,
    ALLOWED_ORIGINS: 'http://localhost:5173',
    MAX_CONNECTIONS_PER_IP: '20',
    BUILD_SHA: 'chaos-check',
    BUILD_VERSION: 'lab-08-local',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stdout.resume(); // Drain JSON logs so stdout backpressure cannot affect the scenario.
child.stderr.resume(); // Drain diagnostics while leaving the terminal output concise.
let witness = null; // Keep handles outside try so failed assertions can still close sockets.
let attacker = null; // Keep the malformed client handle for the same cleanup path.
try {
  const baseUrl = 'http://127.0.0.1:' + port;

  // Wait for readiness and preserve the child output if startup fails.
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error('Server exited during startup with code ' + child.exitCode);
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
  assert.equal(ready, true, 'Server did not become ready within ten seconds');

  // Create two rooms so bad input in one cannot hide a paused tick in the other.
  const roomResponse = await fetch(baseUrl + '/api/rooms', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Malformed traffic room' }),
  });
  assert.equal(roomResponse.status, 201);
  const attackRoom = await roomResponse.json();

  // Connect a healthy witness to the default room and count its ongoing snapshots.
  const originHeaders = { headers: { Origin: 'http://localhost:5173' } };
  witness = new WebSocket('ws://127.0.0.1:' + port + '/ws', originHeaders);
  await once(witness, 'open');
  let witnessSnapshots = 0;
  witness.on('message', (raw, isBinary) => {
    if (!isBinary && JSON.parse(raw.toString()).type === 'snapshot') witnessSnapshots += 1;
  });
  const witnessJoined = waitForType(witness, 'joined_success');
  witness.send(JSON.stringify({ v: 1, type: 'join', room: 'default_room', name: 'Healthy witness', format: 'json' }));
  await witnessJoined;

  // Join a second client to the separate room, then flood it with malformed JSON frames.
  attacker = new WebSocket('ws://127.0.0.1:' + port + '/ws', originHeaders);
  await once(attacker, 'open');
  const attackerJoined = waitForType(attacker, 'joined_success');
  attacker.send(JSON.stringify({ v: 1, type: 'join', room: attackRoom.id, name: 'Malformed sender', format: 'json' }));
  await attackerJoined;
  await new Promise((resolve) => setTimeout(resolve, 500)); // Collect a baseline while the healthy room is running normally.
  const metricsBefore = await fetch(baseUrl + '/metrics').then((response) => response.json());
  const baselineTickP99Ms = metricsBefore.tickDurationP99MsByRoom.default_room;
  const attackerClosed = once(attacker, 'close');
  for (let index = 0; index < 1000; index += 1) attacker.send('{broken-json-' + index);
  const [closeCode] = await attackerClosed;
  await new Promise((resolve) => setTimeout(resolve, 1200)); // Give the witness room time to produce more fixed steps.

  // Confirm the invalid sender was rejected and the unrelated room kept ticking.
  const metricsResponse = await fetch(baseUrl + '/metrics');
  assert.equal(metricsResponse.status, 200);
  const metrics = await metricsResponse.json();
  const healthyRoomTickP99Ms = metrics.tickDurationP99MsByRoom.default_room;
  console.log(
    JSON.stringify({
      malformedFramesAttempted: 1000,
      malformedClientCloseCode: closeCode,
      malformedFramesRejected: metrics.rejectedConnections.invalid_message,
      healthyRoomSnapshots: witnessSnapshots,
      healthyRoomTickP99MsBefore: baselineTickP99Ms,
      healthyRoomTickP99MsAfter: healthyRoomTickP99Ms,
    }),
  );
  assert.equal(
    metrics.rejectedConnections.invalid_message,
    1,
    'The server continued parsing frames after closing the attacker',
  );
  assert.ok(witnessSnapshots >= 10, 'The healthy room did not continue sending snapshots');
  assert.ok(
    healthyRoomTickP99Ms <= Math.max(baselineTickP99Ms * 2 + 2, baselineTickP99Ms + 10),
    'The healthy room step time increased substantially during the malformed-frame test',
  );
  assert.ok([4001, 4002, 4003, 1009].includes(closeCode), 'Malformed client was not disconnected');

  // Simulate a client disappearing mid-match without sending a graceful close frame.
  witness.terminate();
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const current = await fetch(baseUrl + '/metrics').then((response) => response.json());
    if (current.connectedClients === 0) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const finalMetrics = await fetch(baseUrl + '/metrics').then((response) => response.json());
  assert.equal(finalMetrics.connectedClients, 0, 'The server kept a disconnected client');
  console.log(JSON.stringify({ clientsAfterAbruptDisconnect: finalMetrics.connectedClients }));
} finally {
  witness?.terminate(); // Abruptly close any witness socket left open after a failed assertion.
  attacker?.terminate(); // Free the malformed socket if the test stopped before its close frame.
  if (child.exitCode === null) {
    const exited = once(child, 'exit'); // Subscribe before sending SIGTERM so a quick exit cannot be missed.
    child.kill('SIGTERM'); // Ask the test process to flush room logs and close its listener.
    const forceTimer = setTimeout(() => child.kill('SIGKILL'), 3000); // Bound cleanup if graceful shutdown itself fails.
    await exited;
    clearTimeout(forceTimer);
  }
  await rm(logDirectory, { recursive: true, force: true }); // Remove temporary replay files on both pass and failure.
}
