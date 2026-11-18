// Connection is the typed browser boundary for server messages and queued client commands.
import { JSON_PROTOCOL_VERSION, parseServerMessage, type ServerMessage } from '@dogfight/shared/protocol';

type JoinPayload = {
  readonly type: 'join';
  readonly room: string;
  readonly name: string;
  readonly format: 'binary' | 'json';
};
type OutgoingPayload =
  | JoinPayload
  | {
      readonly type: 'input';
      readonly seq: number;
      readonly gas: boolean;
      readonly turn: -1 | 0 | 1;
      readonly shoot: boolean;
    }
  | { readonly type: 'chat'; readonly text: string }
  | { readonly type: 'ping'; readonly sentAt: number }
  | ArrayBuffer
  | ArrayBufferView;
type TrafficEvent = { readonly direction: 'in' | 'out'; readonly bytes: number };
type ConnectionState = 'connecting' | 'open' | 'closed' | 'protocol-error' | 'socket-error';
type MessageFor<Type extends ServerMessage['type']> = Extract<ServerMessage, { type: Type }>;
type ConnectionEvents = {
  joined_success: MessageFor<'joined_success'>;
  roster: MessageFor<'roster'>;
  chat: MessageFor<'chat'>;
  snapshot: MessageFor<'snapshot'>;
  pong: MessageFor<'pong'>;
  binary: ArrayBuffer;
  traffic: TrafficEvent;
};
type EventName = keyof ConnectionEvents;
type EventHandlers = { [Key in EventName]: Set<(payload: ConnectionEvents[Key]) => void> };

// Wraps the browser WebSocket without exposing socket internals to the game.
export function createConnection(url: string) {
  const handlers: EventHandlers = {
    joined_success: new Set(),
    roster: new Set(),
    chat: new Set(),
    snapshot: new Set(),
    pong: new Set(),
    binary: new Set(),
    traffic: new Set(),
  };
  const statusListeners = new Set<(state: ConnectionState, detail?: unknown) => void>();
  const queue: OutgoingPayload[] = [];
  const maxQueue = 100;
  let socket: WebSocket | null = null;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let closedByUser = false;
  let hello: (() => JoinPayload) | null = null;

  // Sends byte counts to netgraph after the simulator delivers a packet.
  function reportTraffic(direction: TrafficEvent['direction'], bytes: number): void {
    dispatch('traffic', { direction, bytes });
  }

  // Notifies the lobby and HUD about connection changes.
  function setStatus(state: ConnectionState, detail?: unknown): void {
    for (const listener of statusListeners) listener(state, detail);
  }

  // Delivers one event to listeners registered for the matching event name.
  function dispatch<Key extends EventName>(type: Key, payload: ConnectionEvents[Key]): void {
    for (const listener of handlers[type]) listener(payload);
  }

  // Adds the JSON protocol version while preserving binary packets byte for byte.
  function sendRaw(payload: OutgoingPayload): void {
    if (payload instanceof ArrayBuffer || ArrayBuffer.isView(payload)) {
      const bytes =
        payload instanceof ArrayBuffer
          ? payload
          : new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength).slice().buffer;
      socket?.send(bytes);
      reportTraffic('out', payload.byteLength);
      return;
    }
    const text = JSON.stringify({ v: JSON_PROTOCOL_VERSION, ...payload });
    socket?.send(text);
    reportTraffic('out', new TextEncoder().encode(text).byteLength);
  }

  // Retries transient disconnections with bounded exponential backoff and jitter.
  function scheduleReconnect(): void {
    const delayBase = Math.min(1000 * 2 ** attempt, 15000);
    const delay = Math.round(delayBase * (0.75 + Math.random() * 0.5));
    attempt += 1;
    timer = setTimeout(connect, delay);
  }

  // Opens a socket and installs typed message handlers.
  function connect(): void {
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
    closedByUser = false;
    setStatus('connecting');
    try {
      socket = new WebSocket(url);
    } catch (error: unknown) {
      setStatus('closed', error);
      scheduleReconnect();
      return;
    }
    socket.binaryType = 'arraybuffer';
    socket.addEventListener('open', () => {
      attempt = 0;
      if (hello) sendRaw(hello());
      while (queue.length > 0) {
        const next = queue.shift();
        if (next !== undefined) sendRaw(next);
      }
      setStatus('open');
    });
    socket.addEventListener('message', (event: MessageEvent<unknown>) => {
      const data = event.data;
      const byteCount =
        data instanceof ArrayBuffer || ArrayBuffer.isView(data)
          ? data.byteLength
          : new TextEncoder().encode(String(data)).byteLength;
      reportTraffic('in', byteCount);
      if (data instanceof ArrayBuffer) {
        dispatch('binary', data);
        return;
      }
      let decoded: unknown;
      try {
        if (typeof data !== 'string') throw new TypeError('Expected a text server message');
        decoded = JSON.parse(data);
      } catch (error: unknown) {
        setStatus('protocol-error', error instanceof Error ? error.message : 'invalid JSON');
        return;
      }
      const result = parseServerMessage(decoded);
      if (!result.ok) {
        setStatus('protocol-error', result.reason);
        return;
      }
      dispatchServerMessage(result.message);
    });
    socket.addEventListener('error', (event: Event) => setStatus('socket-error', event));
    socket.addEventListener('close', (event: CloseEvent) => {
      setStatus('closed', { code: event.code, reason: event.reason });
      if (closedByUser || [1000, 1008, 1009, 4001, 4002, 4004, 4005].includes(event.code)) return;
      scheduleReconnect();
    });
  }

  // Exhaustively routes a validated server union to the matching typed listener set.
  function dispatchServerMessage(message: ServerMessage): void {
    switch (message.type) {
      case 'joined_success':
        dispatch('joined_success', message);
        return;
      case 'roster':
        dispatch('roster', message);
        return;
      case 'chat':
        dispatch('chat', message);
        return;
      case 'snapshot':
        dispatch('snapshot', message);
        return;
      case 'pong':
        dispatch('pong', message);
        return;
      default: {
        const exhaustive: never = message;
        return exhaustive;
      }
    }
  }

  // Sends a command now or keeps it in the bounded queue until the socket opens.
  function send(payload: OutgoingPayload): void {
    if (socket?.readyState === WebSocket.OPEN) {
      sendRaw(payload);
      return;
    }
    if (queue.length >= maxQueue) queue.shift();
    queue.push(payload);
  }

  // Subscribes to one event and returns a function that removes that listener.
  function on<Key extends EventName>(type: Key, listener: (payload: ConnectionEvents[Key]) => void): () => void {
    handlers[type].add(listener);
    return () => handlers[type].delete(listener);
  }

  // Subscribes to lifecycle status updates and returns an unsubscribe function.
  function onStatus(listener: (state: ConnectionState, detail?: unknown) => void): () => void {
    statusListeners.add(listener);
    return () => statusListeners.delete(listener);
  }

  // Stores the join request that should be sent after every reconnect.
  function setHello(factory: () => JoinPayload): void {
    hello = factory;
  }

  // Cancels reconnects, drops this session's queue, and closes its socket.
  function close(): void {
    closedByUser = true;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    queue.length = 0;
    socket?.close(1000, 'left room');
  }

  return { connect, send, on, onStatus, setHello, close };
}
