// Бінарний декодер спільний для браузера й сервера.
import { deserializeSnapshot } from '@dogfight/shared/protocol';

type SocketPayload = string | ArrayBuffer | Blob;
type Listener = (payload: unknown) => void;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Цей сумісний клієнт зберігає чергу, повторне підключення й підписки за типом події.
export class WSClient {
  private readonly url: string;
  private ws: WebSocket | null = null;
  private readonly sendQueue: SocketPayload[] = [];
  private readonly listeners = new Map<string, Listener[]>();
  private reconnectAttempts = 0;
  private readonly maxReconnectDelay = 10_000;
  private isIntentionalClose = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(url: string) {
    this.url = url; // Зберігаємо адресу сервера для повторного з'єднання.
  }

  connect(): void {
    this.isIntentionalClose = false; // Новий виклик connect означає, що клієнт знову хоче з'єднання.
    const socket = new WebSocket(this.url); // Створюємо системний браузерний WebSocket.
    this.ws = socket; // Зберігаємо сокет, щоб інші методи могли ним користуватися.
    socket.binaryType = 'arraybuffer'; // Просимо браузер віддавати бінарні кадри як ArrayBuffer.

    socket.onopen = () => {
      this.reconnectAttempts = 0; // Успішне з'єднання скидає лічильник повторів.
      this.#flushQueue(); // Відправляємо дані, які накопичилися до відкриття сокета.
      this.#emit('open'); // Повідомляємо підписників про відкриття.
    };

    socket.onmessage = (event: MessageEvent): void => {
      if (event.data instanceof ArrayBuffer) {
        try {
          const snapshot = deserializeSnapshot(event.data); // Перевіряємо й декодуємо бінарний знімок.
          this.#emit('snapshot', snapshot); // Передаємо типізований стан без додаткових полів.
          this.#emit('binary', event.data); // Окремо даємо споживачам доступ до байтів.
        } catch (error: unknown) {
          console.error('[WSClient] Помилка розпакування бінарного знімка:', error); // Записуємо помилку протоколу.
        }
        return; // Бінарний кадр не є JSON-повідомленням.
      }

      if (typeof event.data !== 'string') {
        console.error('[WSClient] Отримано непідтримуваний тип повідомлення'); // WebSocket налаштовано на текст або ArrayBuffer.
        return;
      }

      try {
        const data: unknown = JSON.parse(event.data); // JSON з мережі спершу має тип unknown.
        this.#emit('message', data); // Залишаємо загальну подію сумісності.
        if (isRecord(data) && typeof data.type === 'string') this.#emit(data.type, data); // Подію за типом надсилаємо лише після перевірки.
      } catch (error: unknown) {
        console.error('[WSClient] Помилка парсингу текстового повідомлення:', error); // Не даємо пошкодженому JSON зупинити клієнт.
      }
    };

    socket.onclose = (event: CloseEvent): void => {
      this.#emit('close', event); // Передаємо код закриття підписникам.
      if (!this.isIntentionalClose) this.#scheduleReconnect(); // Відновлюємо тільки неочікуваний розрив.
    };

    socket.onerror = (error: Event): void => {
      console.error('[WSClient] Помилка сокета:', error); // Зберігаємо діагностику в консолі.
      this.#emit('error', error); // Даємо коду застосунку відреагувати на помилку.
    };
  }

  send(data: unknown): void {
    let payload: SocketPayload;
    if (typeof data === 'string' || data instanceof ArrayBuffer || data instanceof Blob) {
      payload = data; // Бінарні дані й готовий текст відправляються без перетворень.
    } else if (ArrayBuffer.isView(data)) {
      payload = new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice().buffer; // Копіюємо view у звичайний ArrayBuffer.
    } else {
      const serialized = JSON.stringify(data); // Інші значення передаємо сумісним JSON-повідомленням.
      if (serialized === undefined) return; // undefined не має мережевого подання.
      payload = serialized;
    }

    if (this.ws?.readyState === WebSocket.OPEN)
      this.ws.send(payload); // Відправляємо одразу, коли сокет відкритий.
    else this.sendQueue.push(payload); // Інакше зберігаємо дані до відкриття.
  }

  close(): void {
    this.isIntentionalClose = true; // Забороняємо автоматичне повторне з'єднання.
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer); // Скасовуємо таймер, якщо він уже запущений.
    this.reconnectTimer = null; // Очищаємо посилання на завершений таймер.
    this.ws?.close(1000, 'Normal Closure'); // Закриваємо активний сокет стандартним кодом.
  }

  on(event: string, callback: Listener): void {
    const listeners = this.listeners.get(event) ?? []; // Беремо поточний список або починаємо новий.
    listeners.push(callback); // Додаємо типізовану функцію підписника.
    this.listeners.set(event, listeners); // Зберігаємо список у Map за назвою події.
  }

  #flushQueue(): void {
    const socket = this.ws; // Беремо конкретний сокет для цього проходу черги.
    if (!socket) return; // Немає куди відправляти повідомлення.
    while (this.sendQueue.length > 0 && socket.readyState === WebSocket.OPEN) {
      const payload = this.sendQueue.shift(); // Вилучаємо перше повідомлення.
      if (payload === undefined) break; // Перевірка потрібна для noUncheckedIndexedAccess.
      socket.send(payload); // Відправляємо повідомлення у початковому порядку.
    }
  }

  #scheduleReconnect(): void {
    if (this.reconnectTimer !== null || this.isIntentionalClose) return; // Не створюємо кілька таймерів для одного розриву.
    this.reconnectAttempts += 1; // Збільшуємо номер повторної спроби.
    const exponent = Math.min(this.reconnectAttempts - 1, 20); // Обмежуємо степінь, щоб число залишалося безпечним.
    const delay = Math.min(1000 * 2 ** exponent, this.maxReconnectDelay); // Подвоюємо паузу до встановленої межі.
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null; // Таймер більше не очікує.
      if (!this.isIntentionalClose) this.connect(); // Перепідключаємося лише за бажанням користувача.
    }, delay);
  }

  #emit(event: string, payload: unknown = undefined): void {
    for (const listener of this.listeners.get(event) ?? []) listener(payload); // Викликаємо лише підписників цієї події.
  }
}
