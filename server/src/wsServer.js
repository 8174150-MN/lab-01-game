import { WebSocketServer } from "ws";

export function setupWebSocket(server, roomManager) {
  // Створюємо WebSocket-сервер поверх стандартного HTTP-сервера
  const wss = new WebSocketServer({ server });

  // Перевірка активності клієнтів (Heartbeat / Ping-Pong) кожні 15 секунд
  const interval = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (ws.isAlive === false) {
        // Якщо клієнт не відповів на попередній ping — розриваємо з'єднання
        return ws.terminate();
      }
      ws.isAlive = false;
      ws.ping(); // Надсилаємо ping
    });
  }, 15000);

  wss.on("close", () => clearInterval(interval));

  // Обробка кожного нового WebSocket підключення
  wss.on("connection", (ws) => {
    ws.isAlive = true;
    ws.joinedRoom = null;
    ws.joined = false;
    ws.msgCount = 0;

    // Скидаємо лічильник повідомлень кожну секунду (Rate Limiting)
    const rateInterval = setInterval(() => {
      ws.msgCount = 0;
    }, 1000);

    // Таймаут входу (5 секунд): закриває сокет з кодом 4003, якщо гравець не надіслав 'join'
    const joinTimeout = setTimeout(() => {
      if (!ws.joined) {
        ws.close(4003, "join timeout");
      }
    }, 5000);

    // Підтвердження присутності від клієнта
    ws.on("pong", () => {
      ws.isAlive = true;
    });

    // Обробка вхідних повідомлень від клієнта
    ws.on("message", (raw) => {
      // 1. Захист від завеликих повідомлень (>64 КБ)
      if (raw.length > 64 * 1024) return ws.close(1009, "Payload too large");

      // 2. Захист від спаму: не більше 10 повідомлень на секунду
      ws.msgCount++;
      if (ws.msgCount > 10) return ws.close(1008, "Rate limit exceeded");

      // 3. Парсинг JSON
      let data;
      try {
        data = JSON.parse(raw.toString());
      } catch {
        return ws.close(1007, "Invalid JSON");
      }

      if (!data || typeof data.type !== "string") {
        return ws.close(1003, "Missing message type");
      }

      // Обробка команди 'join' (приєднання до кімнати)
      if (data.type === "join") {
        if (ws.joined) return;
        const roomId = data.roomId;
        const username = data.username || "Гравець";

        // Пошук кімнати через roomManager
        const room = typeof roomManager.getRoom === "function"
          ? roomManager.getRoom(roomId)
          : roomManager.get(roomId);

        if (!room) {
          ws.send(JSON.stringify({ type: "error", message: "Кімнату не знайдено" }));
          return ws.close(4004, "Room not found");
        }

        // Намагаємося додати клієнта в кімнату
        const ok = room.addClient(ws, username);
        if (!ok) {
          ws.send(JSON.stringify({ type: "error", message: "Кімната заповнена" }));
          return ws.close(4003, "Room full");
        }

        ws.joined = true;
        ws.joinedRoom = room;
        clearTimeout(joinTimeout); // Скасовуємо таймер таймауту входу

        // Відправляємо події входу для фронтенду
        ws.send(JSON.stringify({ type: "joined_success", roomId: room.id, username }));
        ws.send(JSON.stringify({ type: "joined", roomId: room.id, username }));
      } 
      // Обробка чат-повідомлення
      else if (data.type === "chat") {
        if (!ws.joined || !ws.joinedRoom) return ws.close(1008, "Not in room");
        if (typeof data.text !== "string" || !data.text.trim()) return;

        ws.joinedRoom.sendChatMessage(ws, data.text.trim());
      }
    });

    // Очищення ресурсів при закритті сокета
    ws.on("close", () => {
      clearTimeout(joinTimeout);
      clearInterval(rateInterval);
      if (ws.joinedRoom) {
        ws.joinedRoom.removeClient(ws);
      }
    });
  });

  // Функція плавного закриття всіх сокетів для Graceful Shutdown
  function closeAll() {
    for (const ws of wss.clients) {
      ws.close(1001, "Server shutting down");
    }
    wss.close();
  }

  return { closeAll };
}