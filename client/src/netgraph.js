// client/src/netgraph.js

export class NetGraph {
  constructor() {
    // Метрики гри для виводу
    this.rtt = 0; // Затримка туди і назад (Ping)
    this.snapshotAge = 0; // Час з моменту отримання останнього знімка
    this.bytesPerSec = 0; // Трафік у байтах за секунду
    this.pendingInputCount = 0; // Кількість інпутів у черзі клієнта
    this.reconError = 0; // Величина виправлення позиції після звірки
    this.bytesAccumulator = 0; // Тимчасовий лічильник байтів

    // Скидаємо та перераховуємо байти/с кожну секунду
    setInterval(() => {
      this.bytesPerSec = this.bytesAccumulator;
      this.bytesAccumulator = 0;
    }, 1000);
  }

  // Запис розміру отриманого/відправленого пакета
  addBytes(count) {
    this.bytesAccumulator += count;
  }

  // Малювання інформаційної панелі на Canvas
  draw(ctx) {
    ctx.save();
    ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
    ctx.fillRect(10, 10, 220, 110); // Темний фон під текст

    ctx.fillStyle = '#00FF00'; // Зелений колір тексту
    ctx.font = '12px monospace';

    // Виводимо всі необхідні метрики за вимогами лаби 5
    ctx.fillText(`RTT (Ping): ${Math.round(this.rtt)} ms`, 20, 30);
    ctx.fillText(`Snapshot Age: ${Math.round(this.snapshotAge)} ms`, 20, 45);
    ctx.fillText(`Bandwidth: ${this.bytesPerSec} bytes/s`, 20, 60);
    ctx.fillText(`Input Queue: ${this.pendingInputCount}`, 20, 75);
    ctx.fillText(`Recon Error: ${this.reconError.toFixed(2)} px`, 20, 90);
    ctx.restore();
  }
}
