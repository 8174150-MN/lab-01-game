// Інтерфейс містить лише поля й методи, потрібні ping/pong-перевірці.
export interface HeartbeatSocket {
  missedPongs: number;
  pingOutstanding: boolean;
  ping(): void;
  terminate(): void;
}

export const HEARTBEAT_INTERVAL_MS = 15_000; // Сервер перевіряє активність раз на п'ятнадцять секунд.

// Перевіряємо відповідь на попередній ping і надсилаємо наступний.
export function sendHeartbeat(sockets: Iterable<HeartbeatSocket>): void {
  for (const socket of sockets) {
    if (socket.pingOutstanding) {
      socket.missedPongs += 1; // Рахуємо пропуск лише після попереднього ping.
      if (socket.missedPongs >= 2) {
        socket.terminate(); // Від'єднуємо клієнта після двох пропущених pong.
        continue; // Не надсилаємо ping вже завершеному сокету.
      }
    }
    socket.pingOutstanding = true; // Фіксуємо новий ping, на який треба відповісти.
    socket.ping(); // ws автоматично надішле pong-відповідь клієнту.
  }
}
