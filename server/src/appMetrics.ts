// This small in-memory registry exposes the measurements needed by the lab at /metrics.
const WINDOW_SECONDS = 10; // A short rolling window makes rates react to current traffic.
interface TrafficBucket {
  second: number; // The epoch-second stored in this ring slot.
  messagesIn: number; // Incoming WebSocket frame count in this second.
  messagesOut: number; // Outgoing WebSocket frame count in this second.
  bytesIn: number; // Incoming WebSocket bytes in this second.
  bytesOut: number; // Outgoing WebSocket bytes in this second.
}

// Allocate the fixed ring once so message accounting does not grow with uptime.
const buckets: TrafficBucket[] = Array.from({ length: WINDOW_SECONDS }, () => ({
  second: -1,
  messagesIn: 0,
  messagesOut: 0,
  bytesIn: 0,
  bytesOut: 0,
}));
const rejected = new Map<string, number>(); // Keep cumulative counts by safe, fixed rejection reason.
const startedAt = Date.now(); // Use startup time to size the initial rate window.

// Return the ring slot for this second and reset it when time advances.
function currentBucket(): TrafficBucket {
  const second = Math.floor(Date.now() / 1000); // Bucket by wall-clock seconds; simulation itself uses a monotonic clock.
  const bucket = buckets[second % WINDOW_SECONDS]; // The ring has one slot for each second in the window.
  if (!bucket) throw new Error('Traffic metric ring is not initialized'); // Keep strict indexed access explicit.
  if (bucket.second !== second) {
    bucket.second = second;
    bucket.messagesIn = 0;
    bucket.messagesOut = 0;
    bucket.bytesIn = 0;
    bucket.bytesOut = 0;
  } // Clear stale counts before reusing this slot.
  return bucket;
}

// Count one received or sent WebSocket frame and its encoded byte length.
export function recordTraffic(direction: 'in' | 'out', bytes: number): void {
  const bucket = currentBucket(); // Find the current one-second counter.
  if (direction === 'in') {
    bucket.messagesIn += 1;
    bucket.bytesIn += bytes;
  } else {
    bucket.messagesOut += 1;
    bucket.bytesOut += bytes;
  } // Store counts without retaining payloads.
}

// Count a rejected handshake or frame by a fixed reason, never by its raw contents.
export function recordRejection(reason: string): void {
  rejected.set(reason, (rejected.get(reason) ?? 0) + 1); // Keep a lifetime counter for dashboards.
}

// Return moving rates and rejection totals as a fresh diagnostic snapshot.
export function getTrafficMetrics(now = Date.now()): {
  readonly messagesInPerSecond: number;
  readonly messagesOutPerSecond: number;
  readonly bytesInPerSecond: number;
  readonly bytesOutPerSecond: number;
  readonly rejectedConnections: Readonly<Record<string, number>>;
} {
  const currentSecond = Math.floor(now / 1000); // Ignore buckets older than the rolling window.
  let messagesIn = 0;
  let messagesOut = 0;
  let bytesIn = 0;
  let bytesOut = 0;
  for (const bucket of buckets) {
    if (bucket.second < currentSecond - WINDOW_SECONDS + 1 || bucket.second > currentSecond) continue;
    messagesIn += bucket.messagesIn;
    messagesOut += bucket.messagesOut;
    bytesIn += bucket.bytesIn;
    bytesOut += bucket.bytesOut;
  } // Sum only the recent ring slots.
  const elapsedSeconds = Math.max(
    1,
    Math.min(WINDOW_SECONDS, (now - Math.max(startedAt, now - WINDOW_SECONDS * 1000)) / 1000),
  );
  const rejectedConnections = Object.fromEntries(rejected); // Serialize counters without exposing mutable Map state.
  return {
    messagesInPerSecond: Number((messagesIn / elapsedSeconds).toFixed(2)),
    messagesOutPerSecond: Number((messagesOut / elapsedSeconds).toFixed(2)),
    bytesInPerSecond: Math.round(bytesIn / elapsedSeconds),
    bytesOutPerSecond: Math.round(bytesOut / elapsedSeconds),
    rejectedConnections,
  };
}
