// WebSocket integration tests use two local clients to exercise the room protocol.
import test from 'node:test'; // Use Node's built-in test runner.
import assert from 'node:assert/strict'; // Compare server messages and close codes.
import http from 'node:http'; // Create an ephemeral local HTTP listener for upgrade requests.
import { once } from 'node:events'; // Wait for server and socket events.
import WebSocket from 'ws'; // Use ws as a test client.
import { mkdir } from 'node:fs/promises'; // Ensure LOG_DIR exists before RoomManager opens logs.
import { config } from '../src/config.js'; // Read the validated log directory.
import { RoomManager } from '../src/rooms.js'; // Create actual room state.
import { setupWebSocket } from '../src/wsServer.js'; // Attach the production WebSocket implementation.

function waitForType(socket, type) {
  return new Promise((resolve, reject) => {
    // Resolve only after a matching protocol message arrives.
    const timer = setTimeout(() => {
      socket.off('message', onMessage);
      reject(new Error('Timed out waiting for ' + type));
    }, 3000); // Bound a stalled test.
    function onMessage(raw) {
      const message = JSON.parse(raw.toString());
      if (message.type !== type) return;
      clearTimeout(timer);
      socket.off('message', onMessage);
      resolve(message);
    } // Ignore other message types until the one requested arrives.
    socket.on('message', onMessage); // Subscribe before the test sends its trigger.
  }); // Finish the wait helper.
} // Finish protocol message waiting.

function waitForClose(socket) {
  return new Promise((resolve) => socket.once('close', (code, reason) => resolve({ code, reason: reason.toString() }))); // Capture the server close code and reason.
} // Finish close waiting.

test('two clients join, receive rosters, and exchange chat', async (context) => {
  await mkdir(config.LOG_DIR, { recursive: true }); // Make the test independent of a prior server start.
  const manager = new RoomManager(); // Create the lobby room.
  const server = http.createServer(); // The HTTP body is unused; only the upgrade endpoint is under test.
  const { closeAll } = setupWebSocket(server, manager); // Install the real WebSocket protocol.
  server.listen(0, '127.0.0.1'); // Ask the operating system for a free local port.
  await once(server, 'listening'); // Wait until the socket accepts connections.
  const address = server.address(); // Read the selected ephemeral port.
  const first = new WebSocket('ws://127.0.0.1:' + address.port + '/ws'); // Connect the first player.
  const second = new WebSocket('ws://127.0.0.1:' + address.port + '/ws'); // Connect the second player.
  context.after(async () => {
    first.close();
    second.close();
    await closeAll();
    await new Promise((resolve) => server.close(resolve));
    await manager.close();
  }); // Always close client, listener, and room log resources.
  await Promise.all([once(first, 'open'), once(second, 'open')]); // Wait for both WebSocket handshakes.
  const firstJoined = waitForType(first, 'joined_success'); // Register before sending the first join.
  const secondJoined = waitForType(second, 'joined_success'); // Register before sending the second join.
  first.send(JSON.stringify({ v: 1, type: 'join', room: 'default_room', name: 'Pilot One' })); // Join with a versioned room message.
  second.send(JSON.stringify({ v: 1, type: 'join', room: 'default_room', name: 'Pilot Two' })); // Join the same room from a second socket.
  const [firstAck, secondAck] = await Promise.all([firstJoined, secondJoined]); // Wait for both server confirmations.
  assert.equal(firstAck.roomId, 'default_room'); // Confirm the requested room was used.
  assert.equal(secondAck.players.length, 2); // Confirm both players are in the roster.
  const receivedChat = waitForType(second, 'chat'); // Subscribe the second client before the first sends.
  first.send(JSON.stringify({ v: 1, type: 'chat', text: 'hello room' })); // Send a validated chat line.
  const chat = await receivedChat; // Wait for the room broadcast.
  assert.equal(chat.sender, 'Pilot One'); // The server derives the sender from its socket record.
  assert.equal(chat.text, 'hello room'); // The validated text reaches the other client.
  first.close(); // Start a clean close for the first client.
  second.close(); // Start a clean close for the second client.
}); // Finish two-client integration test.

test('unknown WebSocket message types close with the protocol error code', async (context) => {
  await mkdir(config.LOG_DIR, { recursive: true }); // Ensure logger setup works from a clean checkout.
  const manager = new RoomManager(); // Create room state for the socket server.
  const server = http.createServer(); // Create a local HTTP upgrade listener.
  const { closeAll } = setupWebSocket(server, manager); // Install message validation and lifecycle logic.
  server.listen(0, '127.0.0.1'); // Bind an ephemeral test port.
  await once(server, 'listening'); // Wait until the server is ready.
  const socket = new WebSocket('ws://127.0.0.1:' + server.address().port + '/ws'); // Create one protocol test client.
  context.after(async () => {
    socket.close();
    await closeAll();
    await new Promise((resolve) => server.close(resolve));
    await manager.close();
  }); // Release all resources even when the assertion fails.
  await once(socket, 'open'); // Wait for the WebSocket handshake.
  const closed = waitForClose(socket); // Listen before sending the invalid frame.
  socket.send(JSON.stringify({ v: 1, type: 'unknown' })); // Send a valid JSON object with an unsupported type.
  const result = await closed; // Wait for the server's protocol close.
  assert.equal(result.code, 4002); // Unknown message types use the documented close code.
}); // Finish unknown-type integration test.
