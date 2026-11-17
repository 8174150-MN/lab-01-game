// Session binds the generic socket to the room protocol.
import { createConnection } from './connection.js'; // Reuse queue and reconnect behavior.

export function startSession({ roomId, name, onRoster, onChat, onStatus }) {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws'; // Match WebSocket security to the page scheme.
  const connection = createConnection(scheme + '://' + location.host + '/ws'); // Connect through the Vite proxy or production server.
  connection.setHello(() => ({ type: 'join', room: roomId, name })); // Rejoin the selected room after every reconnect.
  connection.onStatus((state, detail) => onStatus?.(state, detail)); // Forward open, close, and error states to the caller.
  connection.on('joined_success', (message) => onStatus?.('joined', message)); // Report successful room entry.
  connection.on('roster', (message) => onRoster?.(message)); // Forward the current player list.
  connection.on('chat', (message) => onChat?.(message)); // Forward each chat line.

  connection.connect(); // Start the WebSocket handshake.

  return {
    sendChat(text) {
      connection.send({ type: 'chat', text });
    }, // Send chat through the validated JSON protocol.
    leave() {
      connection.close();
    }, // Close the current room connection and stop retries.
  }; // Finish the public session API.
} // Finish session creation.
