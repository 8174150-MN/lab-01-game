// These tests check that every client message is versioned and allowlisted.
import test from 'node:test'; // Use the built-in Node test runner.
import assert from 'node:assert/strict'; // Compare results without coercion.
import { CLOSE } from '../src/protocol.js'; // Close codes remain part of the Lab 4 server boundary.
import { parseClientMessage } from '@dogfight/shared/protocol'; // The shared Zod schema validates at runtime in both processes.

test('valid join messages return only allowlisted fields', () => {
  const result = parseClientMessage(JSON.stringify({ v: 1, type: 'join', room: 'default_room', name: 'Pilot' })); // Validate a normal join.
  assert.equal(result.ok, true); // The message is accepted.
  if (result.ok)
    assert.deepEqual(result.message, { v: 1, type: 'join', room: 'default_room', name: 'Pilot', format: 'binary' }); // The default binary format is included with the allowlisted fields.
}); // Finish join validation test.

test('invalid shape and unknown message types are rejected with close codes', () => {
  const brokenJson = parseClientMessage('not-json');
  assert.equal(
    brokenJson.ok ? null : brokenJson.kind === 'unknown-type' ? CLOSE.UNKNOWN_TYPE : CLOSE.BAD_FORMAT,
    CLOSE.BAD_FORMAT,
  ); // Broken JSON has a format close code.
  const unknownMessage = parseClientMessage(JSON.stringify({ v: 1, type: 'teleport' }));
  assert.equal(
    unknownMessage.ok ? null : unknownMessage.kind === 'unknown-type' ? CLOSE.UNKNOWN_TYPE : CLOSE.BAD_FORMAT,
    CLOSE.UNKNOWN_TYPE,
  ); // Unknown types are not ignored.
  assert.equal(
    (() => {
      const result = parseClientMessage(JSON.stringify({ v: 1, type: 'chat', text: 'hello', admin: true }));
      return result.ok ? null : result.kind === 'unknown-type' ? CLOSE.UNKNOWN_TYPE : CLOSE.BAD_FORMAT;
    })(),
    CLOSE.BAD_FORMAT,
  ); // Extra fields fail schema validation.
}); // Finish malformed protocol test.

test('chat text must be present and stay within the configured protocol size', () => {
  assert.equal(parseClientMessage(JSON.stringify({ v: 1, type: 'chat', text: '   ' })).ok, false); // Whitespace is not a message.
  assert.equal(parseClientMessage(JSON.stringify({ v: 1, type: 'chat', text: 'x'.repeat(501) })).ok, false); // Oversized text is rejected.
  assert.equal(parseClientMessage(JSON.stringify({ v: 1, type: 'chat', text: 'hello' })).ok, true); // Ordinary chat is valid.
}); // Finish chat validation test.
