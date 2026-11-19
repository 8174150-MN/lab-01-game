// Точка входу Node спершу створює перевірені ресурси, а вже тоді приймає запити.
import http from 'node:http'; // node:http віддає клієнтську збірку та обробляє API кімнат.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { performance } from 'node:perf_hooks'; // Знімаємо завантаження event loop без сторонньої бібліотеки.
import { mkdir, stat } from 'node:fs/promises'; // Створюємо журнал і перевіряємо, що виробничий shell зібраний.
import { setTimeout as delay } from 'node:timers/promises'; // Навчальний маршрут імітує повільний асинхронний endpoint.
import { config } from './config.js'; // Завантажуємо перевірені параметри середовища.
import { logger } from './appLogger.js'; // Пишемо runtime-події JSON-рядками у stdout.
import { getTrafficMetrics } from './appMetrics.js'; // Віддаємо обмежене рухоме вікно мережевих лічильників.
import { RoomManager } from './rooms.js'; // Керуємо учасниками кімнат і журналами матчів.
import { setupWebSocket } from './wsServer.js'; // Під'єднуємо перевірений lifecycle WebSocket.
import { serveStatic } from './static.js'; // Віддаємо зібрані файли клієнта з перевіркою шляху.
import { streamMatchLog } from './logger.js'; // Передаємо NDJSON replay потоком, не буферизуючи файл.

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value); // Один раз серіалізуємо відповідь у JSON.
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  }); // Вказуємо довжину тіла в байтах, а не символах.
  response.end(body); // Завершуємо HTTP-відповідь.
} // Завершуємо формування JSON-відповіді.

async function readJsonBody(request: IncomingMessage, limit: number): Promise<unknown> {
  const chunks: Buffer[] = []; // Тимчасово зберігаємо тіло запиту, доки воно не перевищує ліміт.
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
let ready = false; // Readiness стає true лише після старту HTTP listener.
let stopping = false; // Один прапорець прибирає сервер із маршрутизації під час shutdown.
let previousEventLoop = performance.eventLoopUtilization(); // База для виміру завантаження циклу між запитами /metrics.
let staticShellReady = config.NODE_ENV !== 'production'; // У dev клієнтом керує Vite, у production потрібен client/dist.
if (config.NODE_ENV === 'production') {
  try {
    staticShellReady = (await stat(config.DIST_DIR + '/index.html')).isFile(); // Не рекламуємо готовність без головної сторінки.
  } catch (error: unknown) {
    logger.error({ err: error, path: config.DIST_DIR }, 'production client shell is missing'); // Лишаємо процес живим, але readiness буде 503.
  }
}

// Обчислюємо p99 за короткими зразками fixed-step симуляції.
function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0; // До першого кроку p99 дорівнює нулю.
  const sorted = [...values].sort((left, right) => left - right); // Сортуємо лише за окремим HTTP-запитом, не в гарячому циклі.
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1); // Беремо nearest-rank percentile.
  return Number((sorted[index] ?? 0).toFixed(3)); // Округлюємо значення у мілісекундах.
}

async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://' + (request.headers.host || 'localhost')); // Розбираємо шлях і query відносно стабільної адреси.
  const pathname = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : url.pathname; // Прибираємо зайвий слеш у кінці шляху.
  const origin = request.headers.origin;
  if (typeof origin === 'string' && config.ALLOWED_ORIGINS.includes(origin)) {
    response.setHeader('Access-Control-Allow-Origin', origin); // CORS дозволений лише сайтам із конфігурації.
    response.setHeader('Vary', 'Origin'); // Кеші не змішують відповіді для різних origin.
  }
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS'); // Оголошуємо реалізовані HTTP-методи.
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type'); // Дозволяємо JSON-запити POST.
  if (request.method === 'OPTIONS') {
    response.writeHead(204);
    response.end();
    return;
  } // Завершуємо попередній запит браузера без тіла відповіді.

  if (pathname === '/health' && request.method === 'GET') {
    sendJson(response, 200, {
      status: 'ok',
      uptime: process.uptime(),
      version: config.BUILD_VERSION,
      gitSha: config.BUILD_SHA,
      rooms: rooms.rooms.size,
      stepDurationsMs: rooms.getStepDurations(),
    }); // Load script reads server-side simulation timings while clients remain connected.
    return;
  } // Повертаємо стан процесу й кількість кімнат.

  if (pathname === '/ready' && request.method === 'GET') {
    const status = ready && !stopping ? 200 : 503; // Ready відрізняється від liveness під час запуску та shutdown.
    sendJson(response, status, { status: status === 200 ? 'ready' : 'not_ready' });
    return;
  } // Проксі направляє нових гравців лише до готового процесу.

  if (pathname === '/metrics' && request.method === 'GET') {
    const traffic = getTrafficMetrics(); // Отримуємо швидкість кадрів та байтів за останні секунди.
    const stepSamples: number[] = []; // Об'єднуємо невеликі кільцеві вибірки активних кімнат.
    const tickDurationP99MsByRoom: Record<string, number> = {}; // Даємо chaos test порівняти іншу кімнату до і після атаки.
    let connectedPlayers = 0; // Рахуємо людей і ботів у симуляції.
    for (const room of rooms.rooms.values()) {
      connectedPlayers += room.players.size;
      const roomSamples = room.getStepDurationSamples();
      stepSamples.push(...roomSamples);
      tickDurationP99MsByRoom[room.id] = percentile(roomSamples, 0.99);
    } // Збираємо дані тільки коли запитано metrics.
    const eventLoop = performance.eventLoopUtilization(previousEventLoop); // Вимірюємо utilization з попереднього читання.
    previousEventLoop = performance.eventLoopUtilization(); // Переносимо базову точку для наступного інтервалу.
    sendJson(response, 200, {
      connectedPlayers,
      connectedClients: closeAll.getConnectedClients(),
      rooms: rooms.rooms.size,
      messagesInPerSecond: traffic.messagesInPerSecond,
      messagesOutPerSecond: traffic.messagesOutPerSecond,
      bytesInPerSecond: traffic.bytesInPerSecond,
      bytesOutPerSecond: traffic.bytesOutPerSecond,
      tickDurationP99Ms: percentile(stepSamples, 0.99),
      tickDurationP99MsByRoom,
      eventLoopUtilization: Number(eventLoop.utilization.toFixed(4)),
      rssBytes: process.memoryUsage.rss(),
      rejectedConnections: traffic.rejectedConnections,
    }); // Віддаємо JSON-метрики без Prometheus залежності.
    return;
  } // Завершуємо endpoint метрик процесу.

  if (pathname === '/api/stats' && request.method === 'GET') {
    const eventLoop = performance.eventLoopUtilization(); // Знімаємо накопичений час активного й вільного циклу Node.
    sendJson(response, 200, {
      rssBytes: process.memoryUsage().rss,
      eventLoopActiveMs: eventLoop.active,
      eventLoopIdleMs: eventLoop.idle,
      eventLoopUtilization: eventLoop.utilization,
    }); // Повертаємо метрики процесу для локального тесту навантаження.
    return;
  } // Завершуємо маршрут метрик сервера.

  const botRoute = /^\/api\/rooms\/([^/]+)\/bots$/.exec(pathname); // Розпізнаємо окремий endpoint для серверних AI.
  if (botRoute) {
    if (request.method !== 'POST') {
      response.setHeader('Allow', 'POST'); // Показуємо дозволений метод для цього маршруту.
      sendJson(response, 405, { error: 'Method not allowed' });
      return;
    }
    let roomId: string;
    try {
      roomId = decodeURIComponent(botRoute[1] ?? ''); // Декодуємо саме один компонент ідентифікатора.
    } catch {
      sendJson(response, 400, { error: 'Malformed room id' });
      return;
    }
    const body = await readJsonBody(request, config.MAX_BODY_BYTES); // Валідуємо розмір JSON до створення ботів.
    if (
      !isRecord(body) ||
      typeof body.count !== 'number' ||
      !Number.isInteger(body.count) ||
      body.count < 1 ||
      body.count > 16
    ) {
      sendJson(response, 400, { error: 'count must be an integer from 1 to 16' });
      return;
    }
    const added = rooms.addBots(roomId, body.count); // AI підключається до тієї ж серверної кімнати, що й люди.
    if (added < 0) {
      sendJson(response, 404, { error: 'Room not found' });
      return;
    }
    if (added === 0) {
      sendJson(response, 409, { error: 'Room is full' });
      return;
    }
    sendJson(response, 201, { added, roomId }); // Повертаємо фактичну кількість створених ботів.
    return;
  }

  if (pathname === '/api/rooms') {
    // Обробляємо API перегляду й створення кімнат.
    if (request.method === 'GET') {
      sendJson(response, 200, rooms.list());
      return;
    } // Повертаємо актуальний список лобі.
    if (request.method === 'POST') {
      // Створюємо кімнату після перевірки JSON-тіла запиту.
      const body = await readJsonBody(request, config.MAX_BODY_BYTES); // Застосовуємо однаковий ліміт тіла до кожного POST.
      if (!isRecord(body) || typeof body.name !== 'string' || !body.name.trim() || body.name.trim().length > 40) {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const server = http.createServer((request, response) => {
  handleRequest(request, response).catch((error) => {
    // Перетворюємо помилки з async handler на HTTP-відповідь.
    const status = error instanceof Error && 'status' in error && typeof error.status === 'number' ? error.status : 500; // Зберігаємо відомі коди помилок клієнта.
    if (status === 500) logger.error({ err: error, method: request.method }, 'http request failed'); // Записуємо стек і метод без журналювання тіла запиту.
    if (response.headersSent) {
      response.destroy(error instanceof Error ? error : undefined);
      return;
    } // Безпечно завершуємо відповідь, якщо її потік уже почався.
    sendJson(response, status, {
      error: status === 500 ? 'Internal server error' : error instanceof Error ? error.message : 'Request failed',
    }); // Не показуємо клієнту внутрішній стек сервера.
  }); // Завершуємо перетворення HTTP-помилок.
}); // Завершуємо створення HTTP-сервера.

server.on('error', (error) => {
  logger.fatal({ err: error }, 'http server failed');
  process.exitCode = 1;
  logger.flush(() => process.exit(1));
}); // Слухаємо помилки EventEmitter HTTP-сервера і не лишаємо процес у хибному стані.
const closeAll = setupWebSocket(server, rooms); // Під'єднуємо upgrade /ws після створення HTTP-сервера.
server.listen(config.PORT, config.HOST, () => {
  ready = staticShellReady; // Готовність настає після bind і перевірки зібраного клієнта.
  const address = server.address();
  if (address && typeof address !== 'string')
    logger.info({ host: config.HOST, port: address.port }, 'http server listening');
}); // Починаємо слухати порт після налаштування маршрутів і кімнат.

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (stopping) return; // Ігноруємо повторний запит на завершення.
  stopping = true; // Блокуємо паралельний другий shutdown.
  ready = false; // Платформа перестає надсилати нові запити ще до закриття сокетів.
  rooms.closing = true; // Не створюємо кімнати під час graceful shutdown.
  logger.info({ signal }, 'graceful shutdown started'); // Пишемо причину завершення у структурованому форматі.
  const deadline = setTimeout(() => {
    logger.fatal({ signal }, 'graceful shutdown exceeded 9 seconds');
    logger.flush(() => process.exit(1));
  }, 9000); // Залишаємо запас до стандартного десятисекундного docker stop timeout.
  const httpClosed = new Promise((resolve) => server.close(resolve)); // Зупиняємо нові HTTP-запити й чекаємо активні.
  server.closeIdleConnections?.(); // Закриваємо неактивні keep-alive з'єднання.
  try {
    await closeAll.closeAll(); // Надсилаємо shutdown і close 1001, чекаємо вихід гравців.
    server.closeAllConnections?.(); // Закриваємо решту HTTP-з'єднань після WebSocket.
    await httpClosed; // Чекаємо повного закриття HTTP listener.
    await rooms.close(); // Дописуємо потоки журналів усіх кімнат.
    logger.info({ signal }, 'graceful shutdown complete'); // Записуємо подію до фінального flush.
    clearTimeout(deadline); // Успішний shutdown завершився до жорсткого дедлайну.
    logger.flush(() => process.exit(0)); // Node завершується лише після виходу JSON-логів у stdout.
  } catch (error: unknown) {
    logger.fatal({ err: error, signal }, 'graceful shutdown failed');
    clearTimeout(deadline);
    logger.flush(() => process.exit(1));
  }
} // Завершуємо graceful shutdown.

process.on('SIGINT', () => {
  shutdown('SIGINT').catch((error) => {
    logger.fatal({ err: error, signal: 'SIGINT' }, 'shutdown handler failed');
    process.exitCode = 1;
  });
}); // Обробляємо Ctrl+C і повідомляємо про помилки завершення.
process.on('SIGTERM', () => {
  shutdown('SIGTERM').catch((error) => {
    logger.fatal({ err: error, signal: 'SIGTERM' }, 'shutdown handler failed');
    process.exitCode = 1;
  });
}); // Обробляємо сигнал зупинки від менеджера служб.

// Log fatal unknowns and let the process manager restart a clean process.
function crash(error: unknown, event: 'uncaughtException' | 'unhandledRejection'): void {
  logger.fatal({ err: error, event }, 'unhandled process error; exiting'); // Keep the stack and event name in structured logs.
  ready = false; // Stop advertising readiness before the process exits.
  const exitTimer = setTimeout(() => process.exit(1), 1000); // Do not wait indefinitely for a blocked log stream.
  logger.flush(() => {
    clearTimeout(exitTimer);
    process.exit(1);
  }); // Flush Pino before exiting with a failure code.
}

process.on('uncaughtException', (error: Error) => crash(error, 'uncaughtException')); // Unknown synchronous failures must terminate.
process.on('unhandledRejection', (reason: unknown) => crash(reason, 'unhandledRejection')); // Unknown async failures must terminate too.
