// This page measures event-loop and loading behavior in the current browser.
import { integrate } from '../sim/physics.js'; // Reuse the same DOM-free ship physics as the game.
import { isAssetManifest, loadAll, loadAllSequential, loadJson } from '../utils/loader.js'; // Benchmark the actual game asset pipeline.

const output = document.getElementById('output'); // Find the result panel once.
if (!(output instanceof HTMLElement)) throw new Error('Missing experiment output panel');
const write = (value: unknown): void => {
  output.textContent = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}; // Display text safely without HTML parsing.
const percentile = (values: readonly number[], fraction: number): number =>
  [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * fraction))] ?? 0; // Calculate a sample percentile.

async function measureBlocking() {
  const deltas: number[] = []; // Store observed rAF gaps in milliseconds.
  let previous: number | null = null; // Remember the prior callback time.
  let frames = 0; // Count rendered frames.
  let steps = 0; // Count fixed simulation steps.
  let accumulator = 0; // Preserve fractional time between 60 Hz steps.
  const started = performance.now(); // Record the beginning of the measurement.
  return new Promise<{ durationMs: number; frames: number; steps: number; maxFrameMs: number; p95FrameMs: number }>(
    (resolve) => {
      // Resolve after three seconds of browser time.
      function frame(now: number): void {
        if (previous !== null) {
          // Skip timing calculations on the first callback.
          const elapsed = now - previous; // Measure the last callback gap.
          deltas.push(elapsed); // Save the gap for the max-frame statistic.
          accumulator += Math.min(elapsed / 1000, 0.25); // Use the same long-frame clamp as createLoop.
          while (accumulator >= 1 / 60) {
            steps += 1;
            accumulator -= 1 / 60;
          } // Count catch-up physics at a fixed step.
        } // Finish timing and simulation accounting.
        previous = now; // Use this callback as the next timing origin.
        frames += 1; // Count the frame that is being processed.
        if (frames % 60 === 0) {
          const until = performance.now() + 100;
          while (performance.now() < until) {}
        } // Deliberately block the main thread once per sixty frames.
        if (now - started >= 3000) {
          resolve({
            durationMs: Math.round(now - started),
            frames,
            steps,
            maxFrameMs: Number(Math.max(...deltas).toFixed(1)),
            p95FrameMs: Number(percentile(deltas, 0.95).toFixed(1)),
          });
          return;
        } // Return measured values after three seconds.
        requestAnimationFrame(frame); // Schedule the next display-aligned callback.
      } // Finish one measured frame.
      requestAnimationFrame(frame); // Start on the browser's next rendering opportunity.
    },
  ); // Finish the async measurement.
} // Finish blocking experiment.

async function measureInterval() {
  const gaps: number[] = []; // Store actual setInterval callback gaps.
  let previous = performance.now(); // Start the jitter timer before registering the interval.
  let frames = 0; // Count interval callbacks.
  const started = performance.now(); // Record the measurement start.
  return new Promise<{
    durationMs: number;
    frames: number;
    framesPerSecond: number;
    minGapMs: number;
    p95GapMs: number;
    maxGapMs: number;
    note: string;
  }>((resolve) => {
    // Resolve after ten seconds.
    const timer = setInterval(() => {
      // Deliberately use a timer instead of rAF.
      const now = performance.now(); // Read the monotonic callback time.
      gaps.push(now - previous); // Record timer jitter for this callback.
      previous = now; // Move the timing origin forward.
      frames += 1; // Count the timer callback.
      if (now - started >= 10000) {
        clearInterval(timer);
        resolve({
          durationMs: Math.round(now - started),
          frames,
          framesPerSecond: Number(((frames * 1000) / (now - started)).toFixed(1)),
          minGapMs: Number(Math.min(...gaps).toFixed(1)),
          p95GapMs: Number(percentile(gaps, 0.95).toFixed(1)),
          maxGapMs: Number(Math.max(...gaps).toFixed(1)),
          note: 'Переключи вкладку на п’ять секунд під час цього виміру й порівняй maxGapMs.',
        });
      } // Report real timer cadence and stop the interval.
    }, 16); // Request a nominal 60 Hz timer.
  }); // Finish timer experiment.
} // Finish setInterval experiment.

function simulateTrajectory(renderHz: number, fixedStep: boolean) {
  let ship = { x: 0, y: 0, vx: 0, vy: 0, angle: 0 }; // Start both runs from the same state.
  let accumulator = 0; // The fixed-step run stores time between render frames.
  const renderDt = 1 / renderHz; // Convert the chosen render frequency into seconds.
  for (let frame = 0; frame < renderHz * 5; frame += 1) {
    // Simulate five seconds at the selected render rate.
    if (fixedStep) {
      accumulator += renderDt;
      while (accumulator >= 1 / 60) {
        ship = integrate(ship, { thrust: true }, 1 / 60);
        accumulator -= 1 / 60;
      }
    } // Run the same 60 Hz physics regardless of rendering.
    else ship = integrate(ship, { thrust: true }, renderDt); // Deliberately couple variable physics to render frequency.
  } // Finish the five-second trajectory.
  return {
    x: Number(ship.x.toFixed(3)),
    y: Number(ship.y.toFixed(3)),
    vx: Number(ship.vx.toFixed(3)),
    vy: Number(ship.vy.toFixed(3)),
  }; // Return reproducible state values.
} // Finish one trajectory run.

async function compareAssets() {
  const rawManifest = await loadJson('/assets/manifest.json'); // Load the same asset list as the game.
  if (!isAssetManifest(rawManifest)) throw new TypeError('Invalid asset manifest');
  const manifest = rawManifest;
  const withNonce = (source: Readonly<Record<string, string>> | undefined, nonce: string): Record<string, string> =>
    Object.fromEntries(Object.entries(source ?? {}).map(([key, url]) => [key, url + '?run=' + nonce])); // Avoid reusing cached files between measurements.
  const now = () => performance.now(); // Use a monotonic high-resolution clock.
  const context = new AudioContext(); // The button click is a user gesture that allows this context.
  await context.resume(); // Unlock playback before decoding the audio files.
  try {
    const sequentialManifest = {
      images: withNonce(manifest.images, 'seq-' + Date.now()),
      sounds: withNonce(manifest.sounds, 'seq-' + Date.now()),
      json: withNonce(manifest.json, 'seq-' + Date.now()),
    }; // Give the sequential pass unique URLs.
    const sequentialStart = now(); // Record when sequential loading begins.
    await loadAllSequential(sequentialManifest, { audioCtx: context }); // Wait for each image, sound, and JSON file in order.
    const sequentialMs = now() - sequentialStart; // Measure the full sequential duration.
    const concurrentManifest = {
      images: withNonce(manifest.images, 'all-' + Date.now()),
      sounds: withNonce(manifest.sounds, 'all-' + Date.now()),
      json: withNonce(manifest.json, 'all-' + Date.now()),
    }; // Give the concurrent pass a different cache key.
    const concurrentStart = now(); // Record when concurrent loading begins.
    await loadAll(concurrentManifest, { audioCtx: context }); // Start each file task together and await Promise.all.
    const concurrentMs = now() - concurrentStart; // Measure the full concurrent duration.
    return {
      sequentialMs: Number(sequentialMs.toFixed(1)),
      concurrentMs: Number(concurrentMs.toFixed(1)),
      speedup: Number((sequentialMs / concurrentMs).toFixed(2)),
      files:
        Object.values(manifest.images ?? {}).length +
        Object.values(manifest.sounds ?? {}).length +
        Object.values(manifest.json ?? {}).length,
    }; // Return durations and the number of assets.
  } finally {
    await context.close();
  } // Release audio resources after decoding.
} // Finish asset comparison.

function requiredButton(id: string): HTMLButtonElement {
  const button = document.getElementById(id);
  if (!(button instanceof HTMLButtonElement)) throw new Error('Missing experiment button: ' + id);
  return button;
}

requiredButton('blocking').addEventListener('click', async () => {
  write('Запущено блокування головного потоку…');
  write(await measureBlocking());
}); // Run and show the first event-loop experiment.
requiredButton('interval').addEventListener('click', async () => {
  write('Працює setInterval 10 секунд; можна перемкнути вкладку на п’ять секунд…');
  write(await measureInterval());
}); // Run and show timer cadence.
requiredButton('timestep').addEventListener('click', () =>
  write({
    variable60Hz: simulateTrajectory(60, false),
    variable10Hz: simulateTrajectory(10, false),
    fixed60Hz: simulateTrajectory(60, true),
    fixed10Hz: simulateTrajectory(10, true),
  }),
); // Compare variable and fixed five-second trajectories.
requiredButton('assets').addEventListener('click', async () => {
  try {
    write('Завантажую активи послідовно й паралельно…');
    write(await compareAssets());
  } catch (error: unknown) {
    write('Не вдалося виміряти активи: ' + (error instanceof Error ? error.message : 'невідома помилка'));
  }
}); // Measure actual manifest resources after a user gesture.
