// lobby.js: дані лобі й мережа. Тут немає жодного DOM.
// fetchJson перевіряє response.ok, тож 404 стане помилкою.
import { fetchJson } from './utils/loader.js';

export interface LobbyRoom {
  readonly id: string;
  readonly name: string;
  readonly players: number;
  readonly maxPlayers: number;
  readonly arena?: { readonly asteroidCount: number };
}
export interface LobbyNetworkOptions {
  readonly authoritative?: boolean;
  readonly prediction?: boolean;
  readonly format?: 'binary' | 'json';
  readonly latencyMs?: number;
  readonly jitterMs?: number;
  readonly packetLoss?: number;
}
interface LobbyOptions {
  readonly url?: string;
  readonly intervalMs?: number;
  readonly timeoutMs?: number;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isLobbyRoom(value: unknown): value is LobbyRoom {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    typeof value.players === 'number' &&
    typeof value.maxPlayers === 'number'
  );
}
class LobbyHttpError extends Error {
  constructor(readonly status: number) {
    super('Сервер повернув HTTP ' + status);
    this.name = 'HttpError';
  }
}

// extends EventTarget: Lobby вміє розсилати події (addEventListener,
// dispatchEvent), як кнопка чи інший елемент сторінки.
export class Lobby extends EventTarget {
  readonly url: string;
  readonly intervalMs: number;
  readonly timeoutMs: number;
  rooms: LobbyRoom[];
  // #поле це приватна змінна, зовні її не видно.
  #controller: AbortController | null = null; // AbortController, поки лобі "живе"
  #timer: number | null = null; // id таймера наступного оновлення

  constructor({ url = '/api/rooms', intervalMs = 1000, timeoutMs = 2000 }: LobbyOptions = {}) {
    super(); // обов'язково: запускає конструктор EventTarget
    this.url = url; // звідки брати кімнати
    this.intervalMs = intervalMs; // як часто оновлювати
    this.timeoutMs = timeoutMs; // скільки чекати на один запит
    this.rooms = []; // останній отриманий список
  }

  // Геттер: lobby.running дає true, якщо оновлення зараз працюють.
  get running(): boolean {
    return this.#controller !== null;
  }

  // start(): лобі стало видимим, запускаємо оновлення.
  start(): void {
    if (this.running) return; // вже запущено
    // Новий контролер: його abort() зупинить усе, що пов'язано з цим сеансом.
    this.#controller = new AbortController();
    this.#tick();
  }

  // stop(): гравець пішов, скасовуємо запит у польоті й таймер.
  stop(): void {
    this.#controller?.abort(); // ?. означає: якщо контролер є
    this.#controller = null;
    if (this.#timer !== null) window.clearTimeout(this.#timer);
  }

  // Один цикл: оновити, дочекатись, запланувати наступний.
  // Наступний запит стартує ПІСЛЯ завершення попереднього,
  // тож запити не накопичуються, якщо сервер повільний.
  async #tick(): Promise<void> {
    const controller = this.#controller;
    await this.refresh();
    // Поки ми чекали, лобі могли зупинити (або зупинити й запустити знову).
    // Якщо контролер змінився, цей цикл уже застарів.
    if (this.#controller !== controller) return;
    this.#timer = window.setTimeout(() => this.#tick(), this.intervalMs);
  }

  // refresh(): один запит. Його можна викликати й вручну (кнопка Retry).
  async refresh(): Promise<void> {
    // "Сеанс лобі": спрацює, коли гравець пішов (stop).
    const lifetime = this.#controller?.signal;

    // Таймаут для цього запиту: через timeoutMs сигнал спрацює сам.
    const signals = [AbortSignal.timeout(this.timeoutMs)];
    if (lifetime) signals.push(lifetime);

    // AbortSignal.any об'єднує сигнали: запит скасується, коли
    // спрацює ХОЧА Б ОДИН з них (таймаут або вихід гравця).
    const signal = AbortSignal.any(signals);

    try {
      const data = await fetchJson(this.url, { signal });

      // Гравець пішов, поки йшов запит: відповідь ігноруємо.
      if (lifetime?.aborted) return;

      // Перевіряємо форму даних: без цього зламаний JSON
      // ламав би інтерфейс далі.
      // Сервер віддає масив напряму; старий формат був { rooms: [...] }. Підтримуємо обидва.
      const list = Array.isArray(data) ? data : isRecord(data) ? data.rooms : undefined;
      // Перевіряємо форму: без масиву далі працювати не можна.
      if (!Array.isArray(list)) throw new Error('Невірний формат rooms');
      // Сервер ще не знає про арену, тож додаємо значення за замовчуванням.
      // Поля самої кімнати йдуть після нього, тому мають пріоритет.
      if (!list.every(isLobbyRoom)) throw new Error('Невірні дані кімнат');
      this.rooms = list.map((room) => ({ arena: { asteroidCount: 5 }, ...room }));
      // Повідомляємо всіх підписників (DOM-модуль): список змінився.
      this.dispatchEvent(new CustomEvent('roomsChanged', { detail: this.rooms }));
    } catch (error: unknown) {
      // abort через stop() не помилка: гравець сам пішов.
      if (lifetime?.aborted) return;
      // Усе інше (404, таймаут, обрив, битий JSON): повідомляємо підписників.
      this.dispatchEvent(new CustomEvent('refreshFailed', { detail: error }));
    }
  }

  // Створюємо кімнату через POST /api/rooms і додаємо її до списку лобі.
  async createRoom(name: string): Promise<LobbyRoom> {
    const cleanName = String(name ?? '').trim(); // Прибираємо пробіли, перш ніж надсилати назву серверу.
    if (!cleanName || cleanName.length > 40) {
      throw new Error('Назва кімнати має містити від 1 до 40 символів'); // Показуємо зрозумілу помилку до HTTP-запиту.
    }

    const response = await fetch(this.url, {
      method: 'POST', // POST просить сервер створити новий запис кімнати.
      headers: { 'Content-Type': 'application/json' }, // Повідомляємо серверу, що тіло має формат JSON.
      body: JSON.stringify({ name: cleanName }), // Надсилаємо лише перевірену назву кімнати.
      signal: this.#controller?.signal, // Дозволяємо скасувати запит, якщо гравець закриє лобі.
    });

    if (!response.ok) {
      throw new LobbyHttpError(response.status); // Зберігаємо статус HTTP для зрозумілого повідомлення в лобі.
    }

    const created: unknown = await response.json(); // Читаємо ID і назву нової кімнати з відповіді сервера.
    if (!isLobbyRoom(created)) {
      throw new Error('Сервер повернув неправильні дані кімнати'); // Не додаємо пошкоджену відповідь у список.
    }

    const room = { arena: { asteroidCount: 5 }, ...created }; // Додаємо стандартне поле арени для сумісності з лобі.
    this.rooms = [...this.rooms.filter((item) => item.id !== room.id), room]; // Оновлюємо список без дубля тієї самої кімнати.
    this.dispatchEvent(new CustomEvent('roomsChanged', { detail: this.rooms })); // Перемальовуємо список у DOM.
    return room; // Даємо кнопці вибрати створену кімнату автоматично.
  }

  // join(): гравець натиснув Join з іменем і кімнатою.
  join(roomId: string | null, name: string, network: LobbyNetworkOptions = {}): void {
    // find шукає першу кімнату з цим id.
    const room = this.rooms.find((r) => r.id === roomId);
    // String(...).trim() прибирає пробіли з країв імені.
    const cleanName = String(name ?? '').trim();

    // throw перериває функцію; DOM-модуль покаже текст помилки.
    if (!room) throw new Error('Оберіть кімнату');
    if (!cleanName) throw new Error("Введіть ім'я");

    this.stop(); // гравець іде з лобі: усі запити скасовуємо
    this.dispatchEvent(
      new CustomEvent('joined', {
        detail: { room, name: cleanName, arena: room.arena, network },
      }),
    );
  }
}
