// client/src/netSim.js

export class NetworkSimulator {
  constructor(ws) {
    this.ws = ws; // Посилання на оригінальний WebSocket
    this.latency = 100; // Штучна затримка в мілісекундах (100 мс)
    this.jitter = 20; // Розкид затримки (+/- 20 мс)
    this.packetLoss = 0.0; // Ймовірність втрати пакетів (0.0 = 0%, 0.05 = 5%)
  }

  // Відправка даних на сервер із штучною затримкою
  send(data) {
    // Симуляція втрати пакету (якщо рандом менше ніж % втрат - ігноруємо)
    if (Math.random() < this.packetLoss) return;

    // Обчислюємо випадкову затримку з урахуванням розкиду (jitter)
    const currentDelay = this.latency + (Math.random() * 2 - 1) * this.jitter;

    // Затримуємо відправку пакета у мережу
    setTimeout(
      () => {
        if (this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(data);
        }
      },
      Math.max(0, currentDelay),
    );
  }
}
