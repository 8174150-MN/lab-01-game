// Session поєднує кімнатний WebSocket, мережевий симулятор і формат input.
import { createConnection } from './connection.js';
import { NetworkSimulator } from '../netSim.js';
import { deserializeSnapshot, serializeInput } from '../../../shared/protocol.js';

// Відкриваємо мережеву сесію та повертаємо вузький набір команд для гри.
export function startSession({
  roomId,
  name,
  format = 'binary',
  network = {},
  onRoster,
  onChat,
  onStatus,
  onJoined,
  onSnapshot,
  onPong,
  onBytes,
}) {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  const connection = createConnection(scheme + '://' + location.host + '/ws');
  const simulator = new NetworkSimulator(network);
  let stopped = false;
  let pingTimer = null;
  connection.setHello(() => ({ type: 'join', room: roomId, name, format }));
  connection.onStatus((state, detail) => onStatus?.(state, detail));
  connection.on('traffic', ({ bytes }) => onBytes?.(bytes));
  connection.on('joined_success', (message) => onJoined?.(message));
  connection.on('roster', (message) => onRoster?.(message));
  connection.on('chat', (message) => onChat?.(message));

  // JSON знімки проходять через той самий вхідний симулятор затримки й втрати.
  connection.on('snapshot', (message) => {
    simulator.receive(message, () => onSnapshot?.(message));
  });

  // Бінарний знімок розпаковується тільки після симульованого отримання.
  connection.on('binary', (buffer) => {
    simulator.receive(buffer, () => {
      try {
        onSnapshot?.(deserializeSnapshot(buffer));
      } catch (error) {
        onStatus?.('protocol-error', error.message);
      }
    });
  });

  // RTT включає налаштовану затримку в обох напрямках.
  connection.on('pong', (message) => simulator.receive(message, () => onPong?.(message)));

  // Ping запускається повторно через timeout і зупиняється разом із сесією.
  function schedulePing() {
    if (stopped || pingTimer !== null) return;
    pingTimer = setTimeout(() => {
      pingTimer = null;
      if (stopped) return;
      const ping = { type: 'ping', sentAt: performance.now() };
      simulator.send(ping, () => connection.send(ping));
      schedulePing();
    }, 1000);
  }

  connection.on('joined_success', () => schedulePing());
  connection.connect();

  return {
    // У binary-режимі input є компактним ArrayBuffer, а в JSON — звичайним об'єктом.
    sendInput(input) {
      const payload = format === 'binary' ? serializeInput(input) : { type: 'input', ...input };
      simulator.send(payload, () => connection.send(payload));
    },
    // Чат лишається читабельним текстовим повідомленням лабораторної 4.
    sendChat(text) {
      connection.send({ type: 'chat', text });
    },
    // Закриваємо сокет і скасовуємо очікувані мережеві callback-и.
    leave() {
      stopped = true;
      clearTimeout(pingTimer);
      simulator.close();
      connection.close();
    },
  };
}
