// Цей симулятор додає затримку, розкид і втрату тільки мережевим пакетам.
// Фізика корабля в shared/ ніколи не викликає Math.random().
export class NetworkSimulator {
  constructor({ latencyMs = 0, jitterMs = 0, packetLoss = 0 } = {}) {
    this.latencyMs = latencyMs;
    this.jitterMs = jitterMs;
    this.packetLoss = packetLoss;
    this.timers = new Set();
    this.nextDeliveryAt = { out: 0, in: 0 };
  }

  // Передаємо пакет від браузера до сервера після симульованих умов мережі.
  send(data, deliver, onBytes = () => {}) {
    return this.#transmit('out', data, deliver, onBytes);
  }

  // Передаємо отриманий серверний пакет до гри з такими самими умовами каналу.
  receive(data, deliver, onBytes = () => {}) {
    return this.#transmit('in', data, deliver, onBytes);
  }

  // Застосовуємо втрату, jitter і затримку, зберігаючи порядок у кожному напрямку.
  #transmit(direction, data, deliver, onBytes) {
    if (Math.random() < this.packetLoss) return false;
    const now = performance.now();
    const spread = (Math.random() * 2 - 1) * this.jitterMs;
    const requestedAt = now + Math.max(0, this.latencyMs + spread);
    const deliveryAt = Math.max(requestedAt, this.nextDeliveryAt[direction]);
    this.nextDeliveryAt[direction] = deliveryAt + 0.1;
    const timer = setTimeout(
      () => {
        this.timers.delete(timer);
        onBytes(data.byteLength ?? new TextEncoder().encode(String(data)).byteLength);
        deliver();
      },
      Math.max(0, deliveryAt - now),
    );
    this.timers.add(timer);
    return true;
  }

  // Скасовуємо відкладені пакети, коли гравець залишає кімнату.
  close() {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }
}
