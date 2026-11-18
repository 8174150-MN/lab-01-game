// These tests check that every client message is versioned and allowlisted.
import test from 'node:test'; // Use the built-in Node test runner.
import assert from 'node:assert/strict'; // Compare results without coercion.
import { CLOSE, validateMessage } from '../src/protocol.js'; // Import the production protocol validator.

test('valid join messages return only allowlisted fields', () => {
  const result = validateMessage(JSON.stringify({ v: 1, type: 'join', room: 'default_room', name: 'Pilot' })); // Validate a normal join.
  assert.equal(result.ok, true); // The message is accepted.
  assert.deepEqual(result.message, { type: 'join', room: 'default_room', name: 'Pilot', format: 'binary' }); // The default binary format is included with the allowlisted fields.
}); // Finish join validation test.

test('invalid shape and unknown message types are rejected with close codes', () => {
  assert.equal(validateMessage('not-json').code, CLOSE.BAD_FORMAT); // Broken JSON has a format close code.
  assert.equal(validateMessage(JSON.stringify({ v: 1, type: 'teleport' })).code, CLOSE.UNKNOWN_TYPE); // Unknown types are not ignored.
  assert.equal(
    validateMessage(JSON.stringify({ v: 1, type: 'chat', text: 'hello', admin: true })).code,
    CLOSE.BAD_FORMAT,
  ); // Extra fields fail schema validation.
}); // Finish malformed protocol test.

test('chat text must be present and stay within the configured protocol size', () => {
  assert.equal(validateMessage(JSON.stringify({ v: 1, type: 'chat', text: '   ' })).ok, false); // Whitespace is not a message.
  assert.equal(validateMessage(JSON.stringify({ v: 1, type: 'chat', text: 'x'.repeat(501) })).ok, false); // Oversized text is rejected.
  assert.equal(validateMessage(JSON.stringify({ v: 1, type: 'chat', text: 'hello' })).ok, true); // Ordinary chat is valid.
}); // Finish chat validation test.
