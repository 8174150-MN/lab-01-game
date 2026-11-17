// WebSocket-сервер перевіряє кожен кадр і зберігає стан кімнати для кожного сокета.
import { WebSocketServer } from 'ws'; // ws реалізує кадри RFC 6455, ping/pong і ліміт maxPayload.
import { performance } from 'node:perf_hooks'; // Токен-бакет використовує монотонний годинник.
import { config } from './config.js'; // Ліміти перевіряються один раз під час запуску.
import { CLOSE, validateMessage } from './protocol.js'; // Кожен текстовий кадр проходить перевірку протоколу.

export function setupWebSocket(server, roomManager) {
  const sockets = new WebSocketServer({
    noServer: true,
    maxPayload: config.MAX_MESSAGE_BYTES,
    perMessageDeflate: false,
  }); // Обмежуємо розмір кадру й вимикаємо витрати на стискання.
  const cleanupTasks = new Set(); // Відстежуємо асинхронне очищення кімнати та логу після close.
  const heartbeat = setInterval(() => {
    // Перевіряємо активність з'єднань із потрібним інтервалом у 15 секунд.
    for (const socket of sockets.clients) {
      // Перевіряємо кожне активне з'єднання.
      if (socket.pingOutstanding) {
        socket.missedPongs += 1; // Рахуємо пропуск лише після попереднього ping.
        if (socket.missedPongs >= 2) {
          socket.terminate();
          continue;
        } // Закриваємо з'єднання після двох поспіль пропущених pong.
      } // Перевіряємо попередній запит heartbeat.
      socket.pingOutstanding = true; // Позначаємо новий ping як такий, що очікує відповідь.
      socket.ping(); // Відповідний pong скидає лічильник пропусків.
    } // Завершуємо один обхід heartbeat.
  }, 15000); // Запускаємо heartbeat кожні 15 секунд.
  heartbeat.unref(); // Дозволяємо закритому серверу завершитись без очікування таймера.

  server.on('upgrade', (request, networkSocket, head) => {
    const pathname = new URL(request.url, 'http://localhost').pathname; // Розбираємо шлях запитаного WebSocket endpoint.
    if (pathname !== '/ws') {
      networkSocket.destroy();
      return;
    } // Відхиляємо upgrade за невідомим шляхом.
    sockets.handleUpgrade(request, networkSocket, head, (socket) => sockets.emit('connection', socket, request)); // Завершуємо handshake для /ws.
  }); // Завершуємо маршрутизацію HTTP upgrade.

  sockets.on('error', (error) => console.error('[WebSocketServer]', error)); // Не залишаємо помилки EventEmitter без слухача.
  sockets.on('connection', (socket, _request) => {
    socket.missedPongs = 0; // Починаємо лічильник пропущених відповідей із нуля.
    socket.pingOutstanding = false; // Жоден ping ще не чекає на відповідь.
    socket.room = null; // До чату з'єднання мусить спершу приєднатися до кімнати.
    socket.player = null; // Сервер заповнить поле після коректного join.
    let joinTimer = setTimeout(() => socket.close(CLOSE.JOIN_TIMEOUT, 'join required within five seconds'), 5000); // Встановлюємо дедлайн входу.
    let tokens = config.MAX_MESSAGES_PER_SECOND; // Починаємо з повного ліміту повідомлень на з'єднання.
    let refillAt = performance.now(); // Запам'ятовуємо час останнього поповнення токенів.
    socket.on('error', (error) => console.error('[WebSocket client]', error)); // Додаємо слухач помилок кожного сокета.
    socket.on('pong', () => {
      socket.missedPongs = 0;
      socket.pingOutstanding = false;
    }); // Pong підтверджує, що з'єднання ще активне.

    // Обробляємо перевірений текстовий кадр поточного з'єднання.
    async function handleMessage(raw, isBinary) {
      if (raw.length > config.MAX_MESSAGE_BYTES) {
        console.warn('[ws] oversize message');
        socket.close(1009, 'message too large');
        return;
      } // Закриваємо кадри, більші за заданий ліміт.
      const now = performance.now(); // Беремо монотонний час для обмеження частоти.
      tokens = Math.min(
        config.MAX_MESSAGES_PER_SECOND,
        tokens + ((now - refillAt) / 1000) * config.MAX_MESSAGES_PER_SECOND,
      ); // Поступово поповнюємо токен-бакет.
      refillAt = now; // Зберігаємо час останнього поповнення.
      if (tokens < 1) {
        console.warn('[ws] rate limit');
        socket.close(CLOSE.RATE_LIMIT, 'rate limit exceeded');
        return;
      } // Закриваємо клієнта, який перевищив токен-бакет.
      tokens -= 1; // Витрачаємо один токен на прийняте повідомлення.
      if (isBinary) {
        console.warn('[ws] binary frame is not part of Lab 4');
        socket.close(1003, 'text protocol required');
        return;
      } // У лабораторній 4 протокол приймає перевірені JSON текстові кадри.
      const validation = validateMessage(raw.toString('utf8')); // Перевіряємо версію, тип, ключі та довжину полів.
      if (!validation.ok) {
        console.warn('[ws] invalid message:', validation.reason);
        socket.close(validation.code, validation.reason);
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
        const player = await room.addClient(socket, message.name); // Додаємо гравця й записуємо його в журнал.
        if (!player) {
          socket.close(CLOSE.ROOM_FULL, 'room full');
          return;
        } // Дотримуємося обмеження місткості.
        socket.room = room; // Прив'язуємо вибрану кімнату до сокета.
        socket.player = player; // Прив'язуємо серверний об'єкт гравця до сокета.
        clearTimeout(joinTimer); // Скасовуємо дедлайн join після успіху.
        socket.send(
          JSON.stringify({
            v: 1,
            type: 'joined_success',
            roomId: room.id,
            playerId: player.id,
            players: [...room.players.values()].map((member) => ({ id: member.id, name: member.name })),
          }),
        ); // Підтверджуємо вхід і надсилаємо актуальний список гравців.
        return; // Завершуємо join до обробки чату.
      } // Завершуємо стан до входу в кімнату.

      if (message.type === 'join') {
        socket.close(CLOSE.BAD_FORMAT, 'already joined');
        return;
      } // Не дозволяємо одному сокету змінити кімнату без виходу.
      if (message.type === 'chat') await socket.room.sendChatMessage(socket, message.text); // Записуємо й розсилаємо перевірений чат.
    } // Завершуємо обробку повідомлення.

    socket.on('message', (raw, isBinary) => {
      // ws передає дані та ознаку binary для кожного кадру.
      const task = handleMessage(raw, isBinary).catch((error) => {
        console.error('[ws message]', error);
        socket.close(1011, 'message processing failed');
      }); // Перехоплюємо async-помилки й безпечно закриваємо цей сокет.
      cleanupTasks.add(task); // Відстежуємо роботу для коректного shutdown.
      task.finally(() => cleanupTasks.delete(task)); // Прибираємо завершене завдання з набору очікування.
    }); // Завершуємо підписку на повідомлення.

    socket.on('close', () => {
      // Прибираємо гравця з кімнати після розриву з'єднання.
      clearTimeout(joinTimer); // Звільняємо таймер очікування join.
      if (!socket.room) return; // Сокет без кімнати не має пов'язаних ресурсів.
      const task = socket.room.removeClient(socket).catch((error) => console.error('[room cleanup]', error)); // Записуємо вихід і закриваємо порожню кімнату.
      cleanupTasks.add(task); // Зберігаємо завдання в наборі, який чекає shutdown.
      task.finally(() => cleanupTasks.delete(task)); // Видаляємо завдання після його завершення.
    }); // Завершуємо обробку close.
  }); // Завершуємо налаштування з'єднання.

  // Припиняємо приймати сокети, закриваємо клієнтів і чекаємо очищення кімнат.
  async function closeAll() {
    clearInterval(heartbeat); // Зупиняємо наступні heartbeat callbacks.
    for (const socket of sockets.clients) {
      const timer = setTimeout(() => socket.terminate(), 1000);
      timer.unref();
      socket.once('close', () => clearTimeout(timer));
      socket.close(1001, 'server shutdown');
    } // Просимо клієнтів закритися й примусово завершуємо тих, хто ігнорує handshake.
    await new Promise((resolve) => sockets.close(resolve)); // Зупиняємо WebSocket-сервер після закриття активних клієнтів.
    await Promise.allSettled([...cleanupTasks]); // Чекаємо завершення кожного leave та обробника повідомлення.
  } // Завершуємо WebSocket shutdown.

  return { closeAll }; // Дозволяємо index.js керувати коректним завершенням.
} // Завершуємо налаштування WebSocket.
