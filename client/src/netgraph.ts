// Панель показує мережеві числа без окремого таймера чи залежності від DOM.
export class NetGraph {
  rtt = 0;
  snapshotAge = 0;
  bytesPerSec = 0;
  pendingInputCount = 0;
  reconError = 0;
  lastSnapshotAt = 0;
  byteWindowStartedAt: number;
  byteWindowTotal = 0;
  constructor() {
    this.rtt = 0;
    this.snapshotAge = 0;
    this.bytesPerSec = 0;
    this.pendingInputCount = 0;
    this.reconError = 0;
    this.lastSnapshotAt = 0;
    this.byteWindowStartedAt = performance.now();
    this.byteWindowTotal = 0;
  }

  // RTT береться з відповіді сервера на пакет ping.
  setRtt(milliseconds: number): void {
    this.rtt = milliseconds;
  }

  // Новий знімок скидає вік його віку до нуля.
  snapshotReceived(): void {
    this.lastSnapshotAt = performance.now();
    this.snapshotAge = 0;
  }

  // Рахуємо байти обох напрямків і оновлюємо середнє за останнє вікно часу.
  addBytes(count: number): void {
    this.byteWindowTotal += count;
    const now = performance.now();
    const elapsed = now - this.byteWindowStartedAt;
    if (elapsed >= 1000) {
      this.bytesPerSec = Math.round((this.byteWindowTotal * 1000) / elapsed);
      this.byteWindowTotal = 0;
      this.byteWindowStartedAt = now;
    }
  }

  // Малюємо всі п'ять потрібних метрик поверх арени.
  draw(ctx: CanvasRenderingContext2D): void {
    const now = performance.now();
    this.snapshotAge = this.lastSnapshotAt ? now - this.lastSnapshotAt + this.rtt / 2 : 0;
    ctx.save();
    ctx.fillStyle = 'rgba(0, 0, 0, 0.78)';
    ctx.fillRect(10, 72, 285, 105);
    ctx.fillStyle = '#7CFF8A';
    ctx.font = '13px monospace';
    ctx.fillText('Мережа', 20, 91);
    ctx.fillText('RTT: ' + Math.round(this.rtt) + ' ms', 20, 109);
    ctx.fillText('Вік знімка: ' + Math.round(this.snapshotAge) + ' ms', 20, 127);
    ctx.fillText('Трафік: ' + this.bytesPerSec + ' байт/с', 20, 145);
    ctx.fillText('Input у черзі: ' + this.pendingInputCount, 20, 163);
    ctx.fillText('Поправка: ' + this.reconError.toFixed(1) + ' px', 20, 181);
    ctx.restore();
  }
}
