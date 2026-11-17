// Room tests verify EventEmitter membership, chat delivery, and flushed NDJSON logs.
import test from 'node:test'; // Use the built-in test runner.
import assert from 'node:assert/strict'; // Use strict value checks.
import { mkdir, readFile } from 'node:fs/promises'; // Create the log folder and inspect the finished file.
import { config } from '../src/config.js'; // Read the validated log directory.
import { RoomManager } from '../src/rooms.js'; // Exercise the production room implementation.
import { iterateMatchLog } from '../src/logger.js'; // Read events through the streaming replay iterator.

test('room records join, chat, and leave before removing an empty room', async () => {
  await mkdir(config.LOG_DIR, { recursive: true }); // Make tests work from a clean checkout.
  const manager = new RoomManager(); // Create the initial room and its log pipeline.
  const room = manager.getRoom('default_room'); // Select the seeded lobby room.
  const sent = []; // Keep outgoing messages for simple assertions.
  const socket = {
    readyState: 1,
    bufferedAmount: 0,
    send: (text, callback) => {
      sent.push(JSON.parse(text));
      callback?.();
    },
    close() {},
    terminate() {},
  }; // Mock the small WebSocket surface Room needs.
  const events = []; // Record membership event names from EventEmitter.
  room.on('join', () => events.push('join')); // Observe player entry.
  room.on('chat', () => events.push('chat')); // Observe room chat.
  room.on('leave', () => events.push('leave')); // Observe player exit.
  const player = await room.addClient(socket, 'Pilot'); // Add a validated player and wait for its log.
  await room.sendChatMessage(socket, 'hello'); // Send a chat line as the server-owned player.
  await room.removeClient(socket); // Remove the final player and close the log pipeline.
  assert.ok(player.id); // Confirm the server assigned a unique player ID.
  assert.deepEqual(events, ['join', 'chat', 'leave']); // Confirm the expected EventEmitter lifecycle.
  assert.ok(sent.some((message) => message.type === 'roster')); // Confirm the room broadcasts roster changes.
  assert.ok(sent.some((message) => message.type === 'chat' && message.text === 'hello')); // Confirm chat reaches the room.
  assert.equal(manager.getRoom('default_room'), null); // Confirm empty rooms are deleted.
  const parsed = []; // Collect the test replay records.
  for await (const entry of iterateMatchLog('default_room')) parsed.push(entry); // Read the log as an async stream.
  assert.deepEqual(
    parsed.map((entry) => entry.type),
    ['join', 'chat', 'leave'],
  ); // Confirm the Transform wrote all events in order.
  const content = await readFile(room.log.filename, 'utf8'); // Read the small test file only after the streaming assertion.
  assert.equal(content.trim().split('\n').length, 3); // Each event occupies exactly one NDJSON line.
  await manager.close(); // Flush any rooms that remained after assertions.
}); // Finish the room lifecycle test.
