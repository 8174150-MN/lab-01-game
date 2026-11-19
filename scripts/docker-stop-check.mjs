// This smoke check proves that docker stop reaches Node and sends the shutdown protocol frame.
import assert from 'node:assert/strict'; // Fail the workflow when the signal or close code is wrong.
import { spawn } from 'node:child_process'; // Stop the test container while its WebSocket is active.
import WebSocket from 'ws'; // Open a real client connection with a browser-like Origin header.

const containerName = process.argv[2]; // CI passes the container it just started.
if (!containerName) throw new Error('Usage: node scripts/docker-stop-check.mjs <container-name>');

// Wait for one JSON message type while ignoring snapshots and roster updates.
function waitForMessage(socket, type) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for ' + type)), 5000);
    function handleMessage(raw, isBinary) {
      if (isBinary) return;
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (message.type !== type) return;
      clearTimeout(timer);
      socket.off('message', handleMessage);
      resolve(message);
    }
    socket.on('message', handleMessage);
  });
}

// Connect and join so the container has to close a live room participant.
const socket = new WebSocket('ws://127.0.0.1:3000/ws', { headers: { Origin: 'http://localhost:3000' } });
await new Promise((resolve, reject) => {
  socket.once('open', resolve);
  socket.once('error', reject);
});
const joined = waitForMessage(socket, 'joined_success');
socket.send(JSON.stringify({ v: 1, type: 'join', room: 'default_room', name: 'Docker smoke', format: 'json' }));
await joined;

// Observe shutdown before issuing the real Docker signal.
let shutdownNotice = false;
const notice = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('Server did not send a shutdown frame')), 8000);
  socket.on('message', (raw, isBinary) => {
    if (isBinary) return;
    try {
      const message = JSON.parse(raw.toString());
      if (message.type === 'shutdown') {
        shutdownNotice = true;
        clearTimeout(timer);
        resolve(message);
      }
    } catch {
      // Ignore unrelated room messages while waiting for the protocol notice.
    }
  });
});
const closeEvent = new Promise((resolve) => socket.once('close', (code, reason) => resolve({ code, reason })));
const startedAt = Date.now(); // Measure the complete docker stop, including graceful cleanup.
const stopProcess = spawn('docker', ['stop', '--time', '10', containerName], { stdio: 'inherit' });
const stopResult = new Promise((resolve, reject) => {
  stopProcess.once('error', reject);
  stopProcess.once('exit', (code) =>
    code === 0 ? resolve(code) : reject(new Error('docker stop exited with ' + code)),
  );
});
const [shutdownMessage, closed] = await Promise.all([notice, closeEvent]);
await stopResult;

// Check the visible protocol signal, RFC close code, and assignment deadline.
assert.equal(shutdownNotice, true);
assert.equal(shutdownMessage.type, 'shutdown');
assert.equal(closed.code, 1001);
assert.ok(Date.now() - startedAt < 10_000, 'docker stop exceeded 10 seconds');
console.log(
  JSON.stringify({ shutdownMessage: shutdownMessage.type, closeCode: closed.code, stopMs: Date.now() - startedAt }),
);
