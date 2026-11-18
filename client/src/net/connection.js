// Connection wraps WebSocket with a queue, event dispatch, and growing reconnect delays.
const PROTOCOL_VERSION = 1; // The same version is checked by server/src/protocol.js.

export function createConnection(url) {
  const handlers = new Map(); // Each message type maps to its own Set of listeners.
  const statusListeners = new Set(); // Connection state has separate subscribers.
  const queue = []; // Messages wait here until the socket is open.
  const maxQueue = 100; // The queue has a hard limit to avoid unbounded memory.
  let socket = null; // Holds the current WebSocket instance.
  let attempt = 0; // Counts consecutive reconnect failures.
  let timer = null; // Stores the reconnect timeout so close() can cancel it.
  let closedByUser = false; // Distinguishes intentional close from a network failure.
  let hello = null; // Provides the join message for each fresh connection.

  // Report actual WebSocket traffic after the simulator decides to deliver it.
  function reportTraffic(direction, bytes) {
    for (const listener of handlers.get('traffic') ?? []) listener({ direction, bytes });
  } // Keep byte counters separate from JSON message dispatch.

  // Notify all status subscribers.
  function setStatus(state, detail) {
    for (const listener of statusListeners) listener(state, detail); // A listener may update HUD or lobby.
  } // Finish status dispatch.

  // Add protocol version to JSON messages while leaving binary buffers untouched.
  function sendRaw(message) {
    if (message instanceof ArrayBuffer || ArrayBuffer.isView(message)) {
      socket.send(message);
      reportTraffic('out', message.byteLength);
      return;
    } // Preserve binary payloads for later labs.
    const payload = JSON.stringify({ v: PROTOCOL_VERSION, ...message });
    socket.send(payload);
    reportTraffic('out', new TextEncoder().encode(payload).byteLength);
  } // Finish sending one message.

  // Schedule reconnect with exponential growth and random jitter.
  function scheduleReconnect() {
    const delayBase = Math.min(1000 * 2 ** attempt, 15000); // Cap the waiting period at fifteen seconds.
    const delay = Math.round(delayBase * (0.75 + Math.random() * 0.5)); // Spread clients across a jitter window.
    attempt += 1; // The next failure waits longer.
    timer = setTimeout(connect, delay); // Schedule a new connection attempt.
  } // Finish reconnect scheduling.

  // Open a socket and attach all of its event listeners.
  function connect() {
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return; // Avoid duplicate connections.
    closedByUser = false; // This connection attempt is not an intentional close.
    setStatus('connecting'); // Expose the starting state.
    try {
      socket = new WebSocket(url);
    } catch (error) {
      setStatus('closed', error);
      scheduleReconnect();
      return;
    } // Recover from malformed URL or constructor failure.
    socket.binaryType = 'arraybuffer'; // Binary snapshots arrive in a browser-friendly representation.

    socket.addEventListener('open', () => {
      attempt = 0; // A successful connection resets the backoff.
      if (hello) sendRaw(hello()); // Join the selected room before queued chat messages.
      while (queue.length > 0) sendRaw(queue.shift()); // Flush messages in their original order.
      setStatus('open'); // Notify the UI that the socket is ready.
    }); // Finish open handling.

    socket.addEventListener('message', (event) => {
      const receivedBytes =
        event.data instanceof ArrayBuffer || ArrayBuffer.isView(event.data)
          ? event.data.byteLength
          : new TextEncoder().encode(String(event.data)).byteLength;
      reportTraffic('in', receivedBytes);
      if (event.data instanceof ArrayBuffer) {
        // Dispatch binary messages through a reserved type.
        for (const listener of handlers.get('binary') ?? []) listener(event.data); // Keep binary data out of JSON parsing.
        return; // Finish handling this message.
      } // Finish binary dispatch.
      let message; // Declare parsed data outside the try block.
      try {
        message = JSON.parse(event.data);
      } catch {
        setStatus('protocol-error', 'invalid-json');
        return;
      } // Ignore malformed server text safely.
      if (!message || typeof message.type !== 'string') {
        setStatus('protocol-error', 'invalid-shape');
        return;
      } // Require a type for dispatch.
      for (const listener of handlers.get(message.type) ?? []) listener(message); // Call listeners registered for this message type.
    }); // Finish message handling.

    socket.addEventListener('error', (error) => setStatus('socket-error', error)); // Surface the browser socket error to observers.
    socket.addEventListener('close', (event) => {
      setStatus('closed', { code: event.code, reason: event.reason }); // Expose the server's close code and reason.
      if (closedByUser || [1000, 1008, 1009, 4001, 4002, 4004, 4005].includes(event.code)) return; // Do not retry clean or protocol-invalid closes.
      scheduleReconnect(); // Retry transient server and network closures.
    }); // Finish close handling.
  } // Finish connection creation.

  // Send a message now or append it to the bounded queue.
  function send(message) {
    if (socket?.readyState === WebSocket.OPEN) {
      sendRaw(message);
      return;
    } // Deliver immediately when possible.
    if (queue.length >= maxQueue) queue.shift(); // Discard only the oldest queued message at the cap.
    queue.push(message); // Preserve the message for a future open event.
  } // Finish queued sending.

  // Register a message listener and return a function that removes it.
  function on(type, listener) {
    if (!handlers.has(type)) handlers.set(type, new Set()); // Create the listener group lazily.
    handlers.get(type).add(listener); // Store this listener only once.
    return () => handlers.get(type)?.delete(listener); // Allow callers to clean up subscriptions.
  } // Finish message subscription.

  // Register a connection-state listener and return its cleanup function.
  function onStatus(listener) {
    statusListeners.add(listener); // Track the new state listener.
    return () => statusListeners.delete(listener); // Allow callers to unsubscribe.
  } // Finish status subscription.

  // Store the join payload factory used after each reconnect.
  function setHello(factory) {
    hello = factory;
  } // A function keeps the most recent room credentials.

  // Close the active socket and cancel reconnect timers.
  function close() {
    closedByUser = true; // Prevent close event from scheduling a reconnect.
    clearTimeout(timer); // Cancel a pending reconnect attempt.
    queue.length = 0; // Drop messages belonging to the session being closed.
    socket?.close(1000, 'left room'); // Close the current socket with a clean status code.
  } // Finish explicit close.

  // Return the narrow API consumed by session.js.
  return { connect, send, on, onStatus, setHello, close }; // Hide socket internals behind these methods.
} // Finish the client connection factory.
