// Точка входу Node спершу створює перевірені ресурси, а вже тоді приймає запити.
import http from 'node:http'; // node:http віддає клієнтську збірку та обробляє API кімнат.
import { mkdir } from 'node:fs/promises'; // Створюємо LOG_DIR перед відкриттям журналу кімнати.
import { setTimeout as delay } from 'node:timers/promises'; // Навчальний маршрут імітує повільний асинхронний endpoint.
import { config } from './config.js'; // Завантажуємо перевірені параметри середовища.
import { RoomManager } from './rooms.js'; // Керуємо учасниками кімнат і журналами матчів.
import { setupWebSocket } from './wsServer.js'; // Під'єднуємо перевірений lifecycle WebSocket.
import { serveStatic } from './static.js'; // Віддаємо зібрані файли клієнта з перевіркою шляху.
import { streamMatchLog } from './logger.js'; // Передаємо NDJSON replay потоком, не буферизуючи файл.

function sendJson(response, status, value) {
  const body = JSON.stringify(value); // Один раз серіалізуємо відповідь у JSON.
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  }); // Вказуємо довжину тіла в байтах, а не символах.
  response.end(body); // Завершуємо HTTP-відповідь.
} // Завершуємо формування JSON-відповіді.

async function readJsonBody(request, limit) {
  const chunks = []; // Тимчасово зберігаємо тіло запиту, доки воно не перевищує ліміт.
  let size = 0; // Рахуємо байти, а не UTF-16 символи.
  for await (const chunk of request) {
    // Читаємо потік запиту асинхронно, не блокуючи event loop.
    size += chunk.length; // Додаємо поточний Buffer до перевірки ліміту.
    if (size > limit) {
      request.destroy();
      throw Object.assign(new Error('Request body too large'), { status: 413 });
    } // Негайно зупиняємо запит, що перевищив допустимий обсяг.
    chunks.push(chunk); // Зберігаємо фрагмент, поки загальний розмір у межах ліміту.
  } // Завершуємо читання тіла запиту.
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('Malformed JSON body'), { status: 400 });
  } // Розбираємо JSON і повертаємо зрозумілу помилку клієнту.
} // Завершуємо обмежене читання JSON.

await mkdir(config.LOG_DIR, { recursive: true }); // Створюємо папку журналів до відкриття кімнатних потоків.
const rooms = new RoomManager(); // Створюємо початкову кімнату після створення папки логів.

async function handleRequest(request, response) {
  const url = new URL(request.url, 'http://' + (request.headers.host || 'localhost')); // Розбираємо шлях і query відносно стабільної адреси.
  const pathname = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : url.pathname; // Прибираємо зайвий слеш у кінці шляху.
  response.setHeader('Access-Control-Allow-Origin', '*'); // Дозволяємо локальний проксі Vite та браузерні досліди.
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS'); // Оголошуємо реалізовані HTTP-методи.
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type'); // Дозволяємо JSON-запити POST.
  if (request.method === 'OPTIONS') {
    response.writeHead(204);
    response.end();
    return;
  } // Завершуємо попередній запит браузера без тіла відповіді.

  if (pathname === '/health' && request.method === 'GET') {
    sendJson(response, 200, { status: 'ok', uptime: process.uptime(), rooms: rooms.rooms.size });
    return;
  } // Повертаємо стан процесу й кількість кімнат.

  if (pathname === '/api/rooms') {
    // Обробляємо API перегляду й створення кімнат.
    if (request.method === 'GET') {
      sendJson(response, 200, rooms.list());
      return;
    } // Повертаємо актуальний список лобі.
    if (request.method === 'POST') {
      // Створюємо кімнату після перевірки JSON-тіла запиту.
      const body = await readJsonBody(request, config.MAX_BODY_BYTES); // Застосовуємо однаковий ліміт тіла до кожного POST.
      if (!body || typeof body.name !== 'string' || !body.name.trim() || body.name.trim().length > 40) {
        sendJson(response, 400, { error: 'Room name must contain 1–40 characters' });
        return;
      } // Відхиляємо порожні або задовгі назви кімнат.
      const room = rooms.create(body.name); // RoomManager перевіряє загальний ліміт кімнат.
      if (!room) {
        sendJson(response, 503, { error: 'Room limit reached' });
        return;
      } // Повертаємо лобі повідомлення про досягнутий ліміт.
      sendJson(response, 201, room.toJSON()); // Повертаємо створену кімнату.
      return; // Завершуємо гілку POST.
    } // Завершуємо створення кімнати.
    response.setHeader('Allow', 'GET, POST'); // Повідомляємо клієнту про дозволені методи.
    sendJson(response, 405, { error: 'Method not allowed' }); // Відхиляємо невідомий метод.
    return; // Завершуємо обробку API кімнат.
  } // Завершуємо маршрути кімнат.

  if (pathname === '/api/demo/slow' && request.method === 'GET' && config.ENABLE_DEMOS) {
    // Надаємо локальний приклад таймауту без зовнішнього інтернету.
    const requested = Number(url.searchParams.get('delay')) || 3000; // Зчитуємо потрібну затримку в мілісекундах.
    await delay(Math.max(0, Math.min(requested, 10000))); // Обмежуємо затримку, щоб маршрут не чекав безкінечно.
    sendJson(response, 200, { ok: true, delayed: requested }); // Повертаємо коректний JSON після штучної паузи.
    return; // Завершуємо локальну демонстрацію таймауту.
  } // Завершуємо demo-маршрут.

  if (request.method === 'GET' && pathname.startsWith('/api/replays/')) {
    // Потоково віддаємо повтор матчу за ID кімнати.
    let roomId; // Оголошуємо декодований ID поза блоком try.
    try {
      roomId = decodeURIComponent(pathname.slice('/api/replays/'.length)); // Декодуємо лише один ідентифікатор кімнати.
    } catch {
      sendJson(response, 400, { error: 'Malformed replay id' }); // Повертаємо клієнтську помилку для некоректного percent-кодування.
      return; // Не передаємо logger некоректний ID.
    } // Завершуємо безпечне декодування URL.
    const streamed = await streamMatchLog(roomId, response); // Передаємо NDJSON-файл із backpressure.
    if (!streamed) sendJson(response, 404, { error: 'Replay not found' }); // Повертаємо 404, якщо журнал кімнати відсутній.
    return; // Завершуємо обробку повтору матчу.
  } // Завершуємо потрібний маршрут replay.

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    sendJson(response, 405, { error: 'Method not allowed' });
    return;
  } // Статичні файли дозволено лише читати.
  if (pathname.startsWith('/api/')) {
    sendJson(response, 404, { error: 'API route not found' });
    return;
  } // Не передаємо невідомий API-маршрут у handler статичних файлів.
  await serveStatic(request, response, pathname); // Віддаємо запитаний файл клієнтської збірки.
} // Завершуємо обробку HTTP-маршрутів.

const server = http.createServer((request, response) => {
  handleRequest(request, response).catch((error) => {
    // Перетворюємо помилки з async handler на HTTP-відповідь.
    const status = Number.isInteger(error.status) ? error.status : 500; // Зберігаємо відомі коди помилок клієнта.
    if (status === 500) console.error('[HTTP]', error); // Записуємо неочікувані серверні помилки разом зі стеком.
    if (response.headersSent) {
      response.destroy(error);
      return;
    } // Безпечно завершуємо відповідь, якщо її потік уже почався.
    sendJson(response, status, { error: status === 500 ? 'Internal server error' : error.message }); // Не показуємо клієнту внутрішній стек сервера.
  }); // Завершуємо перетворення HTTP-помилок.
}); // Завершуємо створення HTTP-сервера.

server.on('error', (error) => {
  console.error('[HTTP server]', error);
  process.exitCode = 1;
}); // Слухаємо помилки EventEmitter HTTP-сервера.
const { closeAll } = setupWebSocket(server, rooms); // Під'єднуємо upgrade /ws після створення HTTP-сервера.
server.listen(config.PORT, config.HOST, () =>
  console.log('Server listening on http://' + config.HOST + ':' + server.address().port),
); // Починаємо слухати порт після налаштування маршрутів і кімнат.

let stopping = false; // Захищаємо shutdown від повторного виклику двома сигналами.
async function shutdown(signal) {
  if (stopping) return; // Ігноруємо повторний запит на завершення.
  stopping = true; // Блокуємо паралельний другий shutdown.
  console.log('Received ' + signal + '; closing server'); // Записуємо, який системний сигнал почав зупинку.
  const httpClosed = new Promise((resolve) => server.close(resolve)); // Зупиняємо нові HTTP-запити й чекаємо активні.
  server.closeIdleConnections?.(); // Закриваємо неактивні keep-alive з'єднання.
  await closeAll(); // Закриваємо WebSocket і чекаємо записи про вихід із кімнат.
  server.closeAllConnections?.(); // Закриваємо решту HTTP-з'єднань після WebSocket.
  await httpClosed; // Чекаємо повного закриття HTTP listener.
  await rooms.close(); // Дописуємо потоки журналів усіх кімнат.
  console.log('Logs flushed; shutdown complete'); // Повідомляємо, що журнали збережені перед виходом.
  process.exitCode = 0; // Дозволяємо Node завершитися природно з успішним кодом.
} // Завершуємо graceful shutdown.

process.on('SIGINT', () => {
  shutdown('SIGINT').catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}); // Обробляємо Ctrl+C і повідомляємо про помилки завершення.
process.on('SIGTERM', () => {
  shutdown('SIGTERM').catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}); // Обробляємо сигнал зупинки від менеджера служб.
