// Цей симулятор додає затримку, розкид і втрату тільки мережевим пакетам.
// Фізика корабля в shared/ ніколи не викликає Math.random().
interface SimulatorOptions {
  readonly latencyMs?: number;
  readonly jitterMs?: number;
  readonly packetLoss?: number;
}
type Direction = 'out' | 'in';
type Payload = string | ArrayBuffer | ArrayBufferView | object;

export class NetworkSimulator {
  readonly latencyMs: number;
  readonly jitterMs: number;
  readonly packetLoss: number;
  readonly timers = new Set<ReturnType<typeof setTimeout>>();
  readonly nextDeliveryAt: Record<Direction, number> = { out: 0, in: 0 };

  constructor({ latencyMs = 0, jitterMs = 0, packetLoss = 0 }: SimulatorOptions = {}) {
    this.latencyMs = latencyMs;
    this.jitterMs = jitterMs;
    this.packetLoss = packetLoss;
    this.timers = new Set();
    this.nextDeliveryAt = { out: 0, in: 0 };
  }

  // Передаємо пакет від браузера до сервера після симульованих умов мережі.
  send(data: Payload, deliver: () => void, onBytes: (bytes: number) => void = () => {}): boolean {
    return this.#transmit('out', data, deliver, onBytes);
  }

  // Передаємо отриманий серверний пакет до гри з такими самими умовами каналу.
  receive(data: Payload, deliver: () => void, onBytes: (bytes: number) => void = () => {}): boolean {
    return this.#transmit('in', data, deliver, onBytes);
  }

  // Застосовуємо втрату, jitter і затримку, зберігаючи порядок у кожному напрямку.
  #transmit(direction: Direction, data: Payload, deliver: () => void, onBytes: (bytes: number) => void): boolean {
    if (Math.random() < this.packetLoss) return false;
    const now = performance.now();
    const spread = (Math.random() * 2 - 1) * this.jitterMs;
    const requestedAt = now + Math.max(0, this.latencyMs + spread);
    const deliveryAt = Math.max(requestedAt, this.nextDeliveryAt[direction]);
    this.nextDeliveryAt[direction] = deliveryAt + 0.1;
    const timer = setTimeout(
      () => {
        this.timers.delete(timer);
        const bytes =
          data instanceof ArrayBuffer || ArrayBuffer.isView(data)
            ? data.byteLength
            : new TextEncoder().encode(JSON.stringify(data)).byteLength;
        onBytes(bytes);
        deliver();
      },
      Math.max(0, deliveryAt - now),
    );
    this.timers.add(timer);
    return true;
  }

  // Скасовуємо відкладені пакети, коли гравець залишає кімнату.
  close(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }
}
