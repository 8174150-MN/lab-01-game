// These checks prove that the shared fixed-step simulation gives the same result every run.
import test from 'node:test';
import assert from 'node:assert/strict';
import { FIXED_DT, createShipState, integrate } from '../engine.js';
import { asSeq, type InputCommand } from '../types.js';

test('the same ordered input sequence produces the same ship state', () => {
  const inputs: InputCommand[] = Array.from({ length: 600 }, (_, index) => ({
    seq: asSeq(index + 1),
    gas: index % 3 !== 0,
    turn: index % 5 === 0 ? -1 : index % 5 === 1 ? 1 : 0,
    shoot: index % 7 === 0,
  }));
  const run = () => inputs.reduce((state, input) => integrate(state, input, FIXED_DT), createShipState(640, 360));

  assert.deepEqual(run(), run());
});

test('integration returns a new readonly state and keeps its input unchanged', () => {
  const initial = createShipState(640, 360);
  const input: InputCommand = { seq: asSeq(1), gas: true, turn: 0, shoot: false };
  const next = integrate(initial, input, FIXED_DT);

  assert.notEqual(next, initial);
  assert.deepEqual(initial, createShipState(640, 360));
  assert.ok(next.x > initial.x);
});
