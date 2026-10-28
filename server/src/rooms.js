import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { createMatchLogger } from "./logger.js";

// Клас окремої кімнати: успадковує EventEmitter для сповіщення про порожній стан
export class Room extends EventEmitter {
  constructor(id, name) {
    super();
    this.id = id;
    this.name = name;
    this.clients = new Map(); // ws -> player info
    this.players = new Map(); // playerId -> player info
    this.logger = createMatchLogger(id); // Логер для цієї кімнати
    this.maxPlayers = 2;
    this.createdAt = Date.now();
  }

  // Додавання клієнта до кімнати
  addClient(ws, username) {
    if (this.clients.size >= this.maxPlayers) return false;

    const player = { id: randomUUID(), username };
    this.clients.set(ws, player);
    this.players.set(player.id, player);

    // Логуємо подію приєднання гравця
    this.logger.log("PLAYER_JOINED", { username, playerId: player.id });

    // Розсилаємо всім сповіщення про новий вхід
    this.broadcast({
      type: "user_joined",
      user: player.username,
      onlineCount: this.clients.size,
    });

    return true;
  }

  // Видалення клієнта при відключенні
  removeClient(ws) {
    const player = this.clients.get(ws);
    if (!player) return;

    this.clients.delete(ws);
    this.players.delete(player.id);
    
    // Логуємо вихід гравця
    this.logger.log("PLAYER_LEFT", { username: player.username });

    this.broadcast({
      type: "user_left",
      user: player.username,
      onlineCount: this.clients.size,
    });

    // Якщо в кімнаті не залишилось людей — закриваємо логер і сигналізуємо про видалення
    if (this.clients.size === 0) {
      this.logger.close();
      this.emit("empty", this.id);
    }
  }

  // Розсилка повідомлення всім підключеним клієнтам з перевіркою Backpressure
  broadcast(message, senderWs = null) {
    const payload = JSON.stringify(message);
    const MAX_BUFFERED = 64 * 1024; // 64 КБ поріг буфера

    for (const [ws] of this.clients) {
      // Відправляємо лише активним сокетам (readyState === 1)
      if (ws !== senderWs && ws.readyState === 1) {
        // Якщо буфер сокета переповнений, пропускаємо пакет (Backpressure control)
        if (ws.bufferedAmount > MAX_BUFFERED) continue;
        ws.send(payload);
      }
    }
  }

  // Відправка чат-повідомлення
  sendChatMessage(senderWs, text) {
    const player = this.clients.get(senderWs);
    if (!player) return;

    const msg = {
      type: "chat",
      sender: player.username,
      text,
      timestamp: new Date().toISOString(),
    };

    this.logger.log("CHAT_MESSAGE", msg);
    this.broadcast(msg);
  }

  // Безпечне перетворення об'єкта в JSON для API (запобігає рекурсії)
  toJSON() {
    return {
      id: this.id,
      name: this.name,
      players: this.clients.size || this.players.size,
      maxPlayers: this.maxPlayers,
    };
  }
}

// Менеджер усіх кімнат
export class RoomManager {
  constructor() {
    this.rooms = new Map();
    // Створюємо постійну дефолтну кімнату (передаємо isPersistent = true)
    this.createRoom("Кімната 1", true);
  }

  create(name) {
    return this.createRoom(name);
  }

  createRoom(name, isPersistent = false) {
    const id = randomUUID();
    const room = new Room(id, name);
    
    // Автоматично видаляємо тільки тимчасові кімнати, коли вони порожніють
    if (!isPersistent) {
      room.once("empty", () => this.rooms.delete(id));
    }

    this.rooms.set(id, room);
    return room;
  }

  // ... решта методів (getRoom, list тощо) залишаються без змін ...

  // Гнучкий пошук кімнати (виправляє помилку 4004): шукає за ID, за назвою або повертає першу наявну
  getRoom(idOrName) {
    if (!idOrName) return this.rooms.values().next().value;

    // 1. Прямий пошук по Map ID
    if (this.rooms.has(idOrName)) {
      return this.rooms.get(idOrName);
    }

    // 2. Пошук по назві або ID
    for (const room of this.rooms.values()) {
      if (room.id === idOrName || room.name === idOrName) {
        return room;
      }
    }

    // 3. Страховка: якщо ID застарів після перезапуску сервера
    return this.rooms.values().next().value;
  }

  get(idOrName) {
    return this.getRoom(idOrName);
  }

  // Отримання списку кімнат для REST API
  list() {
    return Array.from(this.rooms.values()).map((r) =>
      typeof r.toJSON === "function" ? r.toJSON() : r
    );
  }

  listRooms() {
    return this.list();
  }
}