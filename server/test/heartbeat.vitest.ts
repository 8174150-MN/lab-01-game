import { afterEach, expect, it, vi } from 'vitest'; // Контролюємо heartbeat без реальних 45 секунд очікування.
import { HEARTBEAT_INTERVAL_MS, sendHeartbeat, type HeartbeatSocket } from '../src/heartbeat.js'; // Тестуємо ту саму функцію, що запускає сервер.

afterEach(() => {
  vi.useRealTimers(); // Повертаємо справжній годинник для наступних тестів.
});

it('sends pings on schedule and disconnects after two missed pongs', () => {
  vi.useFakeTimers(); // Переводимо setInterval на контрольований годинник Vitest.
  const socket: HeartbeatSocket = {
    missedPongs: 0,
    pingOutstanding: false,
    ping: vi.fn(),
    terminate: vi.fn(),
  }; // Замість мережевого сокета використовуємо малу тестову реалізацію.
  const timer = setInterval(() => sendHeartbeat([socket]), HEARTBEAT_INTERVAL_MS); // Тестуємо той самий період і heartbeat-функцію.

  vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS); // Перший термін надсилає початковий ping.
  expect(socket.ping).toHaveBeenCalledTimes(1); // Перевіряємо перший сигнал.
  expect(socket.pingOutstanding).toBe(true); // Сервер тепер чекає pong.
  vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS); // Другий термін бачить перший пропуск і надсилає повторний ping.
  expect(socket.missedPongs).toBe(1); // Один пропуск ще не закриває сокет.
  expect(socket.terminate).not.toHaveBeenCalled(); // З'єднання лишається активним.
  vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS); // Третій термін фіксує другий пропуск.
  expect(socket.missedPongs).toBe(2); // Підрахунок двох неповернутих pong завершено.
  expect(socket.terminate).toHaveBeenCalledTimes(1); // Сервер відключив мовчазний клієнт.
  clearInterval(timer); // Прибираємо тестовий періодичний callback.
}); // Завершуємо fake-timer перевірку heartbeat.
