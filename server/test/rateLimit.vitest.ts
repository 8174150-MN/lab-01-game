import { once } from 'node:events'; // Подписуємося на завершення HTTP-сервера.
import http from 'node:http'; // Створюємо локальний сервер без зовнішнього порту.
import { mkdir } from 'node:fs/promises'; // Готуємо каталог журналів кімнати.
import WebSocket from 'ws'; // Відкриваємо справжнє клієнтське WebSocket-з'єднання.
import { expect, it } from 'vitest'; // Перевіряємо поведінку активного сервера.
import { config } from '../src/config.js'; // Читаємо той самий ліміт, що використовує wsServer.
import { CLOSE } from '../src/protocol.js'; // Перевіряємо документований код закриття.
import { RoomManager } from '../src/rooms.js'; // Створюємо звичайний стан кімнати.
import { setupWebSocket } from '../src/wsServer.js'; // Підключаємо справжню реалізацію протоколу.

// Чекаємо на тип повідомлення, не звертаючи уваги на попередні pong або roster кадри.
function waitForMessage(socket: WebSocket, type: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for ' + type)), 3000); // Тест не зависає, якщо сервер мовчить.
    socket.on('message', (raw, isBinary) => {
      if (isBinary) return; // Початковий бінарний знімок не є JSON-відповіддю.
      let message: unknown; // Зберігаємо результат JSON.parse як недовірене значення.
      try {
        message = JSON.parse(raw.toString()); // Розбираємо тільки текстове повідомлення сервера.
      } catch {
        return; // Ігноруємо некоректний кадр, щоб тестовий listener не падав поза promise.
      } // Завершуємо захищений розбір JSON.
      if (typeof message !== 'object' || message === null || !('type' in message) || message.type !== type) return; // Ігноруємо всі інші повідомлення.
      clearTimeout(timer); // Прибираємо дедлайн після знайденої відповіді.
      resolve(message as Record<string, unknown>); // Повертаємо об'єкт, форма якого перевіряється в самому тесті.
    }); // Завершуємо обробку наступного кадру.
  }); // Повертаємо очікування повідомлення.
} // Завершуємо допоміжну функцію очікування.

it('closes a socket after its configured per-second message limit', async () => {
  await mkdir(config.LOG_DIR, { recursive: true }); // Робимо тест незалежним від попереднього запуску сервера.
  const manager = new RoomManager(); // Готуємо стандартну кімнату для входу.
  const server = http.createServer(); // Створюємо HTTP основу для WebSocket upgrade.
  const { closeAll } = setupWebSocket(server, manager); // Реєструємо production handler і його rate limiter.
  server.listen(0, '127.0.0.1'); // Просимо систему видати вільний локальний порт.
  await once(server, 'listening'); // Чекаємо, поки сервер почне приймати з'єднання.
  const address = server.address(); // Читаємо випадково призначений порт.
  if (!address || typeof address === 'string') throw new Error('Test server did not get a TCP port'); // Відхиляємо неочікувану форму адреси.
  const socket = new WebSocket('ws://127.0.0.1:' + address.port + '/ws'); // Підключаємося до реального WebSocket endpoint.
  try {
    await once(socket, 'open'); // Чекаємо завершення handshake.
    const joined = waitForMessage(socket, 'joined_success'); // Слухаємо підтвердження до відправлення join.
    socket.send(JSON.stringify({ v: 1, type: 'join', room: 'default_room', name: 'Rate test' })); // Входимо як звичайний гравець.
    await joined; // Ліміт перевіряється для вже підключеного клієнта.
    const closed = once(socket, 'close'); // Підписуємося до того, як перевищити ліміт.
    const messageCount = config.MAX_MESSAGES_PER_SECOND + 2; // Два зайві кадри гарантують перетин встановленої межі.
    for (let index = 0; index < messageCount; index += 1) {
      socket.send(JSON.stringify({ v: 1, type: 'ping', sentAt: index })); // Кожен кадр має той самий формат, що й клієнтський ping.
    } // Надсилаємо burst в одному короткому інтервалі.
    const [code] = await closed; // Чекаємо, поки сервер відхилить надлишкове повідомлення.
    expect(code).toBe(CLOSE.RATE_LIMIT); // Сервер закриває саме за лімітом частоти.
  } finally {
    socket.close(); // Закриваємо клієнта навіть якщо перевірка завершилася помилкою.
    await closeAll(); // Зупиняємо heartbeat і серверні сокети.
    await new Promise<void>((resolve) => server.close(() => resolve())); // Звільняємо локальний TCP listener.
    await manager.close(); // Дописуємо та закриваємо журнали кімнат.
  } // Завжди звільняємо всі ресурси тесту.
}, 15000); // Завершуємо перевірку rate limit із запасом на Windows CI.
