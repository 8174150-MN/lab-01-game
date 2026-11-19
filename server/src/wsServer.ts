// WebSocket-сервер перевіряє кожен кадр і зберігає стан кімнати для кожного сокета.
import { WebSocketServer } from 'ws'; // ws реалізує кадри RFC 6455, ping/pong і ліміт maxPayload.
import type { WebSocket, RawData } from 'ws';
import type { Server } from 'node:http';
import { config } from './config.js'; // Ліміти перевіряються один раз під час запуску.
import { logger } from './appLogger.js'; // Операційні події мають JSON-формат і йдуть у stdout.
import { recordRejection, recordTraffic } from './appMetrics.js'; // Лічильники не зберігають самі кадри.
import { createRateLimiter } from './rateLimit.js'; // Токен-бакет перевіряється окремими тестами.
import { CLOSE } from './protocol.js'; // Коди закриття лишаються серверною відповідальністю.
import { HEARTBEAT_INTERVAL_MS, sendHeartbeat } from './heartbeat.js'; // Ping/pong логіку можна перевірити окремо фальшивим годинником.
import { deserializeInput, parseClientMessage } from '../../shared/protocol.js'; // JSON та binary проходять спільну runtime-валідацію.
import { ARENA_HEIGHT, ARENA_WIDTH, SIMULATION_HZ } from '../../shared/engine.js'; // Розмір арени й частота беруться зі спільної симуляції.
import type { Room, RoomManager, RoomPlayer } from './rooms.js';

type WireFormat = 'binary' | 'json';

// Додаємо поля, якими сервер прив'язує кімнату та стан heartbeat до кожного сокета.
declare module 'ws' {
  interface WebSocket {
    missedPongs: number;
    pingOutstanding: boolean;
    room: Room | null;
    player: RoomPlayer | null;
    format: WireFormat;
  }
}

function rawLength(raw: RawData): number {
  if (raw instanceof ArrayBuffer) return raw.byteLength;
  return Array.isArray(raw) ? raw.reduce((size, chunk) => size + chunk.byteLength, 0) : raw.byteLength;
}

function rawText(raw: RawData): string {
  if (raw instanceof ArrayBuffer) return new TextDecoder().decode(raw);
  return Array.isArray(raw) ? Buffer.concat(raw).toString('utf8') : raw.toString('utf8');
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function setupWebSocket(
  server: Server,
  roomManager: RoomManager,
): {
  closeAll(): Promise<void>;
  getConnectedClients(): number;
} {
  const sockets = new WebSocketServer({
    noServer: true,
    maxPayload: config.MAX_MESSAGE_BYTES,
    perMessageDeflate: false,
  }); // Обмежуємо розмір кадру й вимикаємо витрати на стискання.
  const cleanupTasks = new Set(); // Відстежуємо асинхронне очищення кімнати та логу після close.
  const connectionsByIp = new Map<string, number>(); // Рахуємо активні сокети для кожної клієнтської IP.
  const socketIps = new WeakMap<WebSocket, string>(); // Даємо зменшити лічильник саме для закритого сокета.
  let closing = false; // Не приймаємо нові upgrade-запити після початку завершення.
  const heartbeat = setInterval(() => sendHeartbeat(sockets.clients), HEARTBEAT_INTERVAL_MS); // Перевіряємо pong-и та плануємо ping кожні п'ятнадцять секунд.
  heartbeat.unref(); // Дозволяємо закритому серверу завершитись без очікування таймера.

  // Повертаємо клієнтську адресу; proxy-заголовок читаємо лише за явної довіри до проксі.
  function clientIp(request: import('node:http').IncomingMessage): string {
    const forwarded = request.headers['x-forwarded-for']; // Reverse proxy може передати вихідну IP.
    if (config.TRUST_PROXY && typeof forwarded === 'string') {
      const first = forwarded.split(',')[0]?.trim(); // Перший елемент — адреса початкового клієнта.
      if (first) return first;
    }
    return request.socket.remoteAddress ?? 'unknown'; // Без довіри до proxy не використовуємо заголовок клієнта.
  }

  // Відхиляємо upgrade до відповіді 101, щоб браузер побачив HTTP-статус.
  function rejectUpgrade(networkSocket: import('node:stream').Duplex, status: number, label: string): void {
    const reason = status === 403 ? 'Forbidden' : status === 429 ? 'Too Many Requests' : 'Service Unavailable';
    const body = label + '\n'; // Тіло містить лише короткий фіксований код причини.
    networkSocket.end(
      'HTTP/1.1 ' +
        status +
        ' ' +
        reason +
        '\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: ' +
        Buffer.byteLength(body) +
        '\r\n\r\n' +
        body,
    ); // Завершуємо незавершений handshake.
  }

  // Browser Origin має бути точним origin зі списку конфігурації.
  function originAllowed(origin: string | undefined): boolean {
    if (!origin) return false; // Вебсокети без Origin не вважаємо браузерними довіреними з'єднаннями.
    try {
      const parsed = new URL(origin);
      return parsed.origin === origin && config.ALLOWED_ORIGINS.includes(origin);
    } catch {
      return false;
    }
  }

  server.on('upgrade', (request, networkSocket, head) => {
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname; // Розбираємо шлях запитаного WebSocket endpoint.
    if (pathname !== '/ws') {
      networkSocket.destroy();
      return;
    } // Відхиляємо upgrade за невідомим шляхом.
    if (closing) {
      recordRejection('server_shutting_down');
      rejectUpgrade(networkSocket, 503, 'server_shutting_down');
      return;
    } // Після SIGTERM сервер більше не пускає нових гравців.
    const origin = request.headers.origin;
    if (!originAllowed(origin)) {
      recordRejection('origin');
      logger.warn({ reason: 'origin', origin: origin ?? null }, 'websocket handshake rejected');
      rejectUpgrade(networkSocket, 403, 'origin_not_allowed');
      return;
    } // Origin перевіряється до виконання WebSocket handshake.
    const ip = clientIp(request);
    if ((connectionsByIp.get(ip) ?? 0) >= config.MAX_CONNECTIONS_PER_IP) {
      recordRejection('ip_limit');
      logger.warn({ reason: 'ip_limit' }, 'websocket handshake rejected');
      rejectUpgrade(networkSocket, 429, 'connection_limit');
      return;
    } // Один IP не може створити більше сокетів за задану межу.
    sockets.handleUpgrade(request, networkSocket, head, (socket) => sockets.emit('connection', socket, request)); // Завершуємо handshake для /ws.
  }); // Завершуємо маршрутизацію HTTP upgrade.

  sockets.on('error', (error) => logger.error({ err: error }, 'websocket server error')); // Не залишаємо помилки EventEmitter без слухача.
  sockets.on('connection', (socket, request) => {
    const ip = clientIp(request); // Повторно визначаємо адресу після успішного handshake.
    socketIps.set(socket, ip); // Зберігаємо адресу без додаткової enumerable-властивості на сокеті.
    connectionsByIp.set(ip, (connectionsByIp.get(ip) ?? 0) + 1); // Займаємо один слот IP-ліміту.
    socket.missedPongs = 0; // Починаємо лічильник пропущених відповідей із нуля.
    socket.pingOutstanding = false; // Жоден ping ще не чекає на відповідь.
    socket.room = null; // До чату з'єднання мусить спершу приєднатися до кімнати.
    socket.player = null; // Сервер заповнить поле після коректного join.
    let joinTimer = setTimeout(() => socket.close(CLOSE.JOIN_TIMEOUT, 'join required within five seconds'), 5000); // Встановлюємо дедлайн входу.
    const rateLimiter = createRateLimiter(config.MAX_MESSAGES_PER_SECOND, config.MAX_MESSAGES_PER_SECOND); // Для кожного сокета створюємо власний ліміт.
    socket.on('error', (error) =>
      logger.warn({ err: error, roomId: socket.room?.id, playerId: socket.player?.id }, 'websocket client error'),
    ); // Додаємо ID кімнати й гравця без збереження IP клієнта.
    socket.on('pong', () => {
      socket.missedPongs = 0;
      socket.pingOutstanding = false;
    }); // Pong підтверджує, що з'єднання ще активне.

    // Обробляємо перевірені текстові та бінарні кадри поточного з'єднання.
    async function handleMessage(raw: RawData, isBinary: boolean): Promise<void> {
      if (socket.readyState !== socket.OPEN) return; // Після першої помилки ігноруємо вже поставлені в чергу кадри.
      const frameBytes = rawLength(raw); // Рахуємо лише довжину кадру, не зберігаючи його копію.
      recordTraffic('in', frameBytes); // Навіть відхилений кадр входить у мережеві метрики.
      if (frameBytes > config.MAX_MESSAGE_BYTES) {
        recordRejection('message_too_large');
        logger.warn(
          { reason: 'message_too_large', roomId: socket.room?.id, playerId: socket.player?.id },
          'websocket frame rejected',
        );
        socket.close(1009, 'message too large');
        return;
      } // Закриваємо кадри, більші за заданий ліміт.
      if (!rateLimiter.consume()) {
        recordRejection('rate_limit');
        logger.warn(
          { reason: 'rate_limit', roomId: socket.room?.id, playerId: socket.player?.id },
          'websocket frame rejected',
        );
        socket.close(CLOSE.RATE_LIMIT, 'rate limit exceeded');
        return;
      } // Відхиляємо повідомлення, якщо запас токенів вичерпаний.
      if (isBinary) {
        if (!socket.room) {
          socket.close(CLOSE.NOT_JOINED, 'join before input');
          return;
        }
        if (socket.format !== 'binary') {
          socket.close(1003, 'binary input is disabled for this session');
          return;
        }
        try {
          const input = deserializeInput(raw);
          socket.room.queueInput(socket, input);
        } catch (error) {
          recordRejection('invalid_binary');
          logger.warn(
            {
              reason: 'invalid_binary',
              detail: errorText(error),
              roomId: socket.room?.id,
              playerId: socket.player?.id,
            },
            'websocket frame rejected',
          );
          socket.close(CLOSE.BAD_FORMAT, 'invalid binary input');
        }
        return;
      } // Бінарний кадр містить тільки кнопки та seq, не координати гравця.
      const validation = parseClientMessage(rawText(raw)); // Zod перевіряє версію, тип, ключі та межі полів.
      if (!validation.ok) {
        recordRejection('invalid_message');
        logger.warn(
          {
            reason: 'invalid_message',
            detail: validation.reason,
            roomId: socket.room?.id,
            playerId: socket.player?.id,
          },
          'websocket frame rejected',
        );
        socket.close(validation.kind === 'unknown-type' ? CLOSE.UNKNOWN_TYPE : CLOSE.BAD_FORMAT, validation.reason);
        return;
      } // Записуємо причину й закриваємо з'єднання з некоректним кадром.
      const message = validation.message; // Використовуємо лише результат із дозволеними полями.

      if (!socket.room) {
        // Перше коректне повідомлення протоколу має приєднати сокет до кімнати.
        if (message.type !== 'join') {
          socket.close(CLOSE.NOT_JOINED, 'join before chat');
          return;
        } // Не дозволяємо чат до входу в кімнату.
        const room = roomManager.getRoom(message.room); // Шукаємо лише кімнату, яку запросив клієнт.
        if (!room) {
          socket.close(CLOSE.ROOM_NOT_FOUND, 'room not found');
          return;
        } // Не перенаправляємо клієнта непомітно до іншої кімнати.
        const player = await room.addClient(socket, message.name, message.format); // Додаємо гравця та обраний JSON або binary формат.
        if (!player) {
          socket.close(CLOSE.ROOM_FULL, 'room full');
          return;
        } // Дотримуємося обмеження місткості.
        socket.room = room; // Прив'язуємо вибрану кімнату до сокета.
        socket.player = player; // Прив'язуємо серверний об'єкт гравця до сокета.
        socket.format = player.format; // Усі знімки далі кодуються у форматі цього клієнта.
        clearTimeout(joinTimer); // Скасовуємо дедлайн join після успіху.
        const joinedPayload = JSON.stringify({
          v: 1,
          type: 'joined_success',
          roomId: room.id,
          playerId: player.id,
          format: player.format,
          seed: room.seed,
          tickRate: SIMULATION_HZ,
          arena: { width: ARENA_WIDTH, height: ARENA_HEIGHT },
          state: room.getPlayerState(player.id),
          snapshot: room.getSnapshot(),
          players: [...room.players.values()].map((member) => ({ id: member.id, name: member.name })),
        }); // Формуємо початковий стан кімнати для нового клієнта.
        socket.send(joinedPayload); // Підтверджуємо вхід і надсилаємо перший знімок світу зі списком гравців.
        recordTraffic('out', Buffer.byteLength(joinedPayload)); // Додаємо початковий пакет до мережевих лічильників.
        logger.info({ roomId: room.id, playerId: player.id }, 'player joined room'); // Не записуємо IP, ім'я чи вміст мережевих повідомлень.
        room.startSimulation(); // Сервер починає фіксований такт після відправлення початкового стану.
        return; // Завершуємо join до обробки чату.
      } // Завершуємо стан до входу в кімнату.

      const joinedRoom = socket.room;
      if (!joinedRoom) {
        socket.close(CLOSE.NOT_JOINED, 'join before message');
        return;
      }
      switch (message.type) {
        case 'join':
          socket.close(CLOSE.BAD_FORMAT, 'already joined');
          return;
        case 'chat':
          await joinedRoom.sendChatMessage(socket, message.text);
          return;
        case 'input':
          if (socket.format !== 'json') {
            socket.close(1003, 'JSON input is disabled for this session');
            return;
          }
          joinedRoom.queueInput(socket, message);
          return;
        case 'ping':
          {
            const pong = JSON.stringify({ v: 1, type: 'pong', sentAt: message.sentAt });
            socket.send(pong);
            recordTraffic('out', Buffer.byteLength(pong));
          }
          return;
        default: {
          const exhaustive: never = message;
          return exhaustive;
        }
      }
    } // Завершуємо обробку повідомлення.

    socket.on('message', (raw: RawData, isBinary: boolean) => {
      // ws передає дані та ознаку binary для кожного кадру.
      const task = handleMessage(raw, isBinary).catch((error: unknown) => {
        logger.error(
          { err: error, roomId: socket.room?.id, playerId: socket.player?.id },
          'websocket message handler failed',
        );
        socket.close(1011, 'message processing failed');
      }); // Перехоплюємо async-помилки й безпечно закриваємо цей сокет.
      cleanupTasks.add(task); // Відстежуємо роботу для коректного shutdown.
      task.finally(() => cleanupTasks.delete(task)); // Прибираємо завершене завдання з набору очікування.
    }); // Завершуємо підписку на повідомлення.

    socket.on('close', () => {
      // Прибираємо гравця з кімнати після розриву з'єднання.
      clearTimeout(joinTimer); // Звільняємо таймер очікування join.
      const disconnectedIp = socketIps.get(socket);
      if (disconnectedIp) {
        const remaining = Math.max(0, (connectionsByIp.get(disconnectedIp) ?? 1) - 1);
        if (remaining === 0) connectionsByIp.delete(disconnectedIp);
        else connectionsByIp.set(disconnectedIp, remaining);
      } // Вивільняємо слот IP навіть якщо клієнт не встиг приєднатися до кімнати.
      if (!socket.room) return; // Сокет без кімнати не має пов'язаних ресурсів.
      const room = socket.room;
      const roomId = room.id;
      const playerId = socket.player?.id;
      logger.info({ roomId, playerId }, 'player left room'); // Журналюємо лише ідентифікатори, не IP чи чат.
      const task = room
        .removeClient(socket)
        .catch((error: unknown) => logger.error({ err: error, roomId, playerId }, 'room cleanup failed')); // Записуємо вихід і закриваємо порожню кімнату.
      cleanupTasks.add(task); // Зберігаємо завдання в наборі, який чекає shutdown.
      task.finally(() => cleanupTasks.delete(task)); // Видаляємо завдання після його завершення.
    }); // Завершуємо обробку close.
  }); // Завершуємо налаштування з'єднання.

  // Припиняємо приймати сокети, закриваємо клієнтів і чекаємо очищення кімнат.
  async function closeAll() {
    closing = true; // Повторний upgrade буде відхилений HTTP-статусом 503.
    clearInterval(heartbeat); // Зупиняємо наступні heartbeat callbacks.
    for (const socket of sockets.clients) {
      const timer = setTimeout(() => socket.terminate(), 1000);
      timer.unref();
      socket.once('close', () => clearTimeout(timer));
      const shutdownMessage = JSON.stringify({
        v: 1,
        type: 'shutdown',
        reason: 'Сервер перезапускається. Ти повернешся до кімнат.',
      });
      if (socket.readyState === socket.OPEN) {
        socket.send(shutdownMessage);
        recordTraffic('out', Buffer.byteLength(shutdownMessage));
      } // Перед close клієнт отримує зрозумілий протокольний сигнал.
      socket.close(1001, 'server shutdown');
    } // Просимо клієнтів закритися й примусово завершуємо тих, хто ігнорує handshake.
    await new Promise((resolve) => sockets.close(resolve)); // Зупиняємо WebSocket-сервер після закриття активних клієнтів.
    await Promise.allSettled([...cleanupTasks]); // Чекаємо завершення кожного leave та обробника повідомлення.
  } // Завершуємо WebSocket shutdown.

  return { closeAll, getConnectedClients: () => sockets.clients.size }; // Віддаємо керування shutdown і число активних з'єднань.
} // Завершуємо налаштування WebSocket.
