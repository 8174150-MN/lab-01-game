// Room зберігає гравців і надсилає EventEmitter-події для журналу та зміни учасників.
import { randomUUID } from 'node:crypto'; // Створюємо унікальні ID кімнат і гравців.
import { EventEmitter } from 'node:events'; // Події Room відокремлюють membership від журналу й HTTP.
import { config } from './config.js'; // Перевірені ліміти задають кількість кімнат і гравців.
import { createMatchLogger } from './logger.js'; // Кожна кімната пише власний потік NDJSON.

export class Room extends EventEmitter {
  // Створюємо порожню кімнату та її журнал матчу.
  constructor(id, name) {
    super(); // Спершу ініціалізуємо EventEmitter, а тоді реєструємо слухачі.
    this.id = id; // Зберігаємо ID кімнати для протоколу лобі.
    this.name = name; // Зберігаємо назву, яку бачить гравець.
    this.clients = new Map(); // Зіставляємо сокет із записом його гравця.
    this.players = new Map(); // Зберігаємо ті самі записи за ID гравця.
    this.maxPlayers = config.MAX_PLAYERS_PER_ROOM; // Застосовуємо задану місткість кімнати.
    this.log = createMatchLogger(id); // Запускаємо pipeline Transform до файла для цієї кімнати.
    this.everJoined = false; // Відрізняємо щойно створену кімнату від спорожнілої після матчу.
    this.closed = false; // Не дозволяємо повторно закрити потік журналу.
  } // Завершуємо створення кімнати.

  // Додаємо гравця, записуємо подію та надсилаємо оновлений список учасників.
  async addClient(socket, username) {
    if (this.clients.size >= this.maxPlayers) return null; // Відхиляємо вхід, якщо кімната вже заповнена.
    const player = { id: randomUUID(), name: username, joinedAt: Date.now() }; // Зберігаємо лише перевірені дані гравця.
    this.clients.set(socket, player); // Пов'язуємо мережеве з'єднання з гравцем.
    this.players.set(player.id, player); // Тримаємо список за ID для формування roster.
    this.everJoined = true; // Видалимо кімнату, коли останній учасник вийде.
    try {
      await this.log.log('join', { roomId: this.id, playerId: player.id, name: player.name });
    } catch (error) {
      this.clients.delete(socket);
      this.players.delete(player.id);
      throw error;
    } // Відкочуємо membership, якщо запис журналу завершився помилкою.
    this.emit('join', player); // Повідомляємо підписників про вхід гравця.
    this.broadcastRoster(); // Розсилаємо оновлений список усім з'єднанням.
    return player; // Повертаємо серверний запис гравця у wsServer.
  } // Завершуємо вхід до кімнати.

  // Прибираємо з'єднання та видаляємо кімнату після виходу останнього гравця.
  async removeClient(socket) {
    const player = this.clients.get(socket); // Знаходимо гравця, якому належить цей сокет.
    if (!player) return; // Ігноруємо повторний close event.
    this.clients.delete(socket); // Перестаємо маршрутизувати дані з цього сокета.
    this.players.delete(player.id); // Прибираємо гравця з наступних списків учасників.
    await this.log.log('leave', { roomId: this.id, playerId: player.id, name: player.name }); // Записуємо вихід до закриття журналу.
    this.emit('leave', player); // Повідомляємо слухачів про зміну membership.
    this.broadcastRoster(); // Показуємо решті гравців, хто залишився.
    if (this.clients.size === 0 && this.everJoined) {
      await this.close();
      this.emit('empty', this.id);
    } // Дописуємо журнал і повідомляємо, що кімната спорожніла.
  } // Завершуємо вихід із кімнати.

  // Розсилаємо список гравців за версійованим протоколом.
  broadcastRoster() {
    const players = [...this.players.values()].map((player) => ({ id: player.id, name: player.name })); // Віддаємо лише публічні поля учасників.
    this.broadcast({ v: 1, type: 'roster', roomId: this.id, players }, true); // Зміни roster є важливими службовими повідомленнями.
  } // Завершуємо розсилання roster.

  // Записуємо й надсилаємо повідомлення чату від учасника кімнати.
  async sendChatMessage(socket, text) {
    const player = this.clients.get(socket); // Сервер бере ім'я відправника з прив'язаного сокета.
    if (!player) return false; // Ігноруємо чат від гравця, який уже вийшов.
    const message = { v: 1, type: 'chat', sender: player.name, text, at: new Date().toISOString() }; // Додаємо перевірені серверні метадані.
    await this.log.log('chat', { roomId: this.id, sender: player.name, text }); // Записуємо чат до його розсилання.
    this.emit('chat', message); // Повідомляємо слухачів кімнати.
    this.broadcast(message); // Доставляємо рядок усім поточним учасникам.
    return true; // Підтверджуємо прийняття повідомлення.
  } // Завершуємо обробку чату.

  // Пропускаємо повільного клієнта для чату й закриваємо його, якщо не вміщуються службові дані.
  broadcast(message, critical = false) {
    const payload = JSON.stringify(message); // Серіалізуємо один текстовий кадр для всіх клієнтів.
    for (const socket of this.clients.keys()) {
      // Перебираємо з'єднання учасників цієї кімнати.
      if (socket.readyState !== 1) continue; // Пропускаємо сокети, які вже закриваються.
      if (socket.bufferedAmount > 64 * 1024) {
        if (critical) socket.close(1013, 'slow client');
        continue;
      } // Відкидаємо звичайні дані або закриваємо повільного одержувача roster.
      socket.send(payload, (error) => {
        if (error) socket.terminate();
      }); // Завершуємо сокет, який не зміг прийняти вихідний кадр.
    } // Завершуємо розсилання активним клієнтам.
  } // Завершуємо broadcast.

  // Повертаємо поля кімнати, які показує GET /api/rooms.
  toJSON() {
    return { id: this.id, name: this.name, players: this.clients.size, maxPlayers: this.maxPlayers }; // Не розкриваємо сокети або внутрішні Map.
  } // Завершуємо створення формату лобі.

  // Дописуємо журнал подій кімнати рівно один раз.
  async close() {
    if (this.closed) return; // Повторний виклик не змінює вже закриту кімнату.
    this.closed = true; // Не дозволяємо двом викликам закривати журнал одночасно.
    await this.log.close(); // Чекаємо, поки pipeline допише й закриє файл.
  } // Завершуємо закриття кімнати.
} // Завершуємо клас кімнати EventEmitter.

export class RoomManager {
  // Створюємо сховище кімнат та одну початкову кімнату лобі.
  constructor() {
    this.rooms = new Map(); // Використовуємо ID кімнати як ключ швидкого пошуку.
    this.maxRooms = config.MAX_ROOMS; // Обмежуємо кількість кімнат цього процесу.
    this.create('Кімната 1', 'default_room'); // Додаємо початкову кімнату, до якої можна приєднатися.
  } // Завершуємо створення менеджера.

  // Створюємо кімнату, якщо не досягнуто заданого серверного ліміту.
  create(name, id = randomUUID()) {
    if (this.rooms.size >= this.maxRooms) return null; // Відхиляємо запит до створення зайвих ресурсів.
    const cleanName = String(name).trim(); // Нормалізуємо назву, яку бачить гравець.
    if (!cleanName || cleanName.length > 40) return null; // Вимагаємо коротке непорожнє ім'я кімнати.
    const room = new Room(id, cleanName); // Створюємо кімнату та її журнал.
    this.rooms.set(room.id, room); // Додаємо кімнату до сховища менеджера.
    room.once('empty', () => this.rooms.delete(room.id)); // Видаляємо кімнату після виходу останнього гравця.
    return room; // Повертаємо кімнату API або WebSocket handler.
  } // Завершуємо створення кімнати.

  // Шукаємо кімнату за точним ID або видимою назвою.
  getRoom(idOrName) {
    if (typeof idOrName !== 'string') return null; // Пошук приймає лише рядковий ключ.
    if (this.rooms.has(idOrName)) return this.rooms.get(idOrName); // Спершу пробуємо точний збіг ID.
    for (const room of this.rooms.values()) if (room.name === idOrName) return room; // Дозволяємо ручним клієнтам вказати назву.
    return null; // Відхиляємо невідому кімнату, а не підмінюємо її іншою.
  } // Завершуємо пошук кімнати.

  // Серіалізуємо поточний стан кімнат для лобі.
  list() {
    return [...this.rooms.values()].map((room) => room.toJSON()); // Повертаємо звичайний масив, сумісний із JSON.
  } // Завершуємо формування списку кімнат.

  // Дописуємо журнали всіх кімнат під час зупинки процесу.
  async close() {
    await Promise.all([...this.rooms.values()].map((room) => room.close())); // Чекаємо завершення pipeline кожної кімнати.
    this.rooms.clear(); // Очищаємо записи кімнат після надійного збереження логів.
  } // Завершуємо зупинку менеджера.
} // Завершуємо менеджер кімнат.
