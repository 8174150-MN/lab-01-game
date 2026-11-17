// The tests verify deterministic simulation helpers without a browser window.
import test from 'node:test'; // Node's built-in test runner avoids extra test dependencies.
import assert from 'node:assert/strict'; // Strict assertions catch type and value differences.
import { integrate, interpolateAngle } from '../src/sim/physics.js'; // Import the DOM-free physics module.
import { wrapPosition, bounceAtBounds } from '../src/sim/arena.js'; // Import the pure arena functions.
import { circlesOverlap, findCircleCollisions } from '../src/sim/collision.js'; // Import the separate circle collision system.
import { createLoop } from '../src/loop.js'; // Import the fixed-step loop with injected frame callbacks.

test('integrate returns a new state and preserves its input', () => {
  const ship = { x: 1, y: 2, vx: 0, vy: 0, angle: 0 }; // Set a reproducible starting state.
  const next = integrate(ship, { thrust: true }, 1 / 60); // Advance one fixed step with thrust.
  assert.notEqual(next, ship); // The function returns a separate object.
  assert.deepEqual(ship, { x: 1, y: 2, vx: 0, vy: 0, angle: 0 }); // The original state remains untouched.
  assert.ok(next.x > ship.x); // A right-facing ship moves right.
  assert.equal(next.y, ship.y); // A right-facing ship does not move vertically.
}); // Finish the pure integration test.

test('angle interpolation chooses the short path around a full turn', () => {
  const value = interpolateAngle(Math.PI - 0.1, -Math.PI + 0.1, 0.5); // Blend across the -π/π boundary.
  assert.ok(Math.abs(Math.abs(value) - Math.PI) < 0.001); // The midpoint stays near π instead of crossing zero.
}); // Finish the angle test.

test('arena wrap and bounce return bounded positions', () => {
  assert.deepEqual(wrapPosition({ x: -5, y: 50 }, 100, 100, 0), { x: 100, y: 50 }); // A point leaving left reappears at right.
  const bounced = bounceAtBounds({ x: 2, y: 50 }, { x: -4, y: 1 }, 100, 100, 5); // A radius-five body touches the left wall.
  assert.equal(bounced.position.x, 5); // The body is returned inside its boundary.
  assert.equal(bounced.velocity.x, 4); // The horizontal direction is reflected.
}); // Finish the arena test.

test('circle collision system reports only allowed overlapping pairs', () => {
  const ship = { kind: 'ship', pos: { x: 0, y: 0 }, radius: 5 }; // Place the first test circle at the origin.
  const asteroid = { kind: 'asteroid', pos: { x: 8, y: 0 }, radius: 5 }; // Place an overlapping second circle.
  const pickup = { kind: 'pickup', pos: { x: 100, y: 100 }, radius: 5 }; // Place a distant third circle.
  assert.equal(circlesOverlap(ship, asteroid), true); // The first two circles overlap by two units.
  assert.deepEqual(
    findCircleCollisions([ship, asteroid, pickup], (a, b) => a.kind === 'ship' && b.kind === 'asteroid'),
    [[ship, asteroid]],
  ); // A filter limits reported pairs.
}); // Finish the collision test.

test('createLoop runs fixed simulation steps and forwards interpolation alpha', () => {
  const frames = []; // Store fake animation callbacks for deterministic control.
  const steps = []; // Store every simulated dt.
  const alphas = []; // Store every interpolation value.
  const loop = createLoop({
    step: 1 / 60,
    simulate: (dt) => steps.push(dt),
    render: (alpha) => alphas.push(alpha),
    requestFrame: (callback) => {
      frames.push(callback);
      return frames.length;
    },
    cancelFrame: () => {},
  }); // Inject a fake rAF scheduler.
  loop.start(); // Schedule the first frame.
  frames.shift()(0); // Establish the initial timestamp without advancing physics.
  frames.shift()(1000 / 30); // Advance thirty-three milliseconds, exactly two fixed steps.
  loop.stop(); // Stop the fake animation loop.
  assert.equal(steps.length, 2); // The accumulator catches up with two 60 Hz steps.
  assert.ok(steps.every((dt) => dt === 1 / 60)); // Every simulation call receives the same dt.
  assert.ok(alphas.every((alpha) => alpha >= 0 && alpha < 1)); // The renderer receives a valid interpolation fraction.
}); // Finish the loop test.
