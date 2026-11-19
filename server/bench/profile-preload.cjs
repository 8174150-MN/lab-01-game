// Load Node's built-in profiler before the server entry point.
const inspector = require('node:inspector'); // Use the V8 inspector API without an external profiler dependency.
const fs = require('node:fs'); // Save the profile synchronously before graceful shutdown.
const path = require('node:path'); // Resolve the output path from the repository root.

// Read and validate the requested profiling window.
const durationMs = Number(process.env.LAB7_PROFILE_DURATION_MS ?? 0); // The profile command sets this duration explicitly.
if (!Number.isFinite(durationMs) || durationMs < 1000 || durationMs > 120000) {
  throw new RangeError('LAB7_PROFILE_DURATION_MS must be between 1000 and 120000'); // Avoid accidental unbounded profiling.
}

// Start profiling inside this process so it includes the actual simulation and server functions.
const session = new inspector.Session(); // Connect an in-process DevTools Protocol client.
session.connect(); // Open the local inspector session without exposing a network debugging port.
session.post('Profiler.enable'); // Enable V8 CPU sampling.
session.post('Profiler.start'); // Begin collecting server execution samples.

// Stop after the measured interval, save the V8 profile, then let the server close itself cleanly.
setTimeout(() => {
  session.post('Profiler.stop', (error, result) => {
    if (error || !result?.profile) {
      console.error('[profile] Could not stop CPU profiler:', error); // Report a failed profile instead of leaving an empty artifact.
      process.kill(process.pid, 'SIGTERM'); // Still request the server's normal shutdown path.
      return; // Finish this timer callback after requesting shutdown.
    }

    const outputPath = path.resolve('server/bench/server-profile-8-clients.cpuprofile'); // Store the profile beside its renderer and README chart.
    fs.writeFileSync(outputPath, JSON.stringify(result.profile)); // Persist the complete V8 profile before server shutdown.
    session.disconnect(); // Release the in-process inspector connection.
    console.log('[profile] Saved', outputPath); // Show the exact artifact path in the terminal.
    process.kill(process.pid, 'SIGTERM'); // Trigger the server's graceful HTTP, WebSocket and log shutdown.
  }); // Finish the current V8 sampling interval and receive its data.
}, durationMs); // Keep the requested server profiling window bounded.
