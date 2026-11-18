// Session поєднує кімнатний WebSocket, мережевий симулятор і формат input.
import { createConnection } from './connection.js';
import { NetworkSimulator } from '../netSim.js';
import { deserializeSnapshot, serializeInput, type JoinedMessage, type ServerMessage } from '@dogfight/shared/protocol';
import type { InputCommand, Snapshot } from '@dogfight/shared/types';

type NetworkOptions = {
  readonly latencyMs?: number;
  readonly jitterMs?: number;
  readonly packetLoss?: number;
};
interface SessionOptions {
  readonly roomId: string;
  readonly name: string;
  readonly format?: 'binary' | 'json';
  readonly network?: NetworkOptions;
  readonly onRoster?: (message: Extract<ServerMessage, { type: 'roster' }>) => void;
  readonly onChat?: (message: Extract<ServerMessage, { type: 'chat' }>) => void;
  readonly onStatus?: (state: string, detail?: unknown) => void;
  readonly onJoined?: (message: JoinedMessage) => void;
  readonly onSnapshot?: (snapshot: Snapshot) => void;
  readonly onPong?: (message: Extract<ServerMessage, { type: 'pong' }>) => void;
  readonly onBytes?: (bytes: number) => void;
}

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
}: SessionOptions): {
  sendInput(input: InputCommand): void;
  sendChat(text: string): void;
  leave(): void;
} {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  const connection = createConnection(scheme + '://' + location.host + '/ws');
  const simulator = new NetworkSimulator(network);
  let stopped = false;
  let pingTimer: ReturnType<typeof window.setTimeout> | null = null;
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
      } catch (error: unknown) {
        onStatus?.('protocol-error', error instanceof Error ? error.message : 'invalid binary snapshot');
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
      const ping: { readonly type: 'ping'; readonly sentAt: number } = { type: 'ping', sentAt: performance.now() };
      simulator.send(ping, () => connection.send(ping));
      schedulePing();
    }, 1000);
  }

  connection.on('joined_success', () => schedulePing());
  connection.connect();

  return {
    // У binary-режимі input є компактним ArrayBuffer, а в JSON — звичайним об'єктом.
    sendInput(input: InputCommand): void {
      if (format === 'binary') {
        const payload = serializeInput(input);
        simulator.send(payload, () => connection.send(payload));
      } else {
        const payload: {
          readonly type: 'input';
          readonly seq: number;
          readonly gas: boolean;
          readonly turn: -1 | 0 | 1;
          readonly shoot: boolean;
        } = {
          type: 'input',
          ...input,
        };
        simulator.send(payload, () => connection.send(payload));
      }
    },
    // Чат лишається читабельним текстовим повідомленням лабораторної 4.
    sendChat(text: string): void {
      connection.send({ type: 'chat', text });
    },
    // Закриваємо сокет і скасовуємо очікувані мережеві callback-и.
    leave(): void {
      stopped = true;
      if (pingTimer !== null) clearTimeout(pingTimer);
      simulator.close();
      connection.close();
    },
  };
}
