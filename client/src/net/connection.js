// Версія протоколу; має дорівнювати PROTOCOL_VERSION у server/src/protocol.js.
const PROTOCOL_VERSION = 1;

// export дозволяє імпортувати цю функцію з інших файлів (ESM).
export function createConnection(url) {
  // Map = словник "ключ → значення". Тут: тип повідомлення → набір обробників.
  const handlers = new Map();
  // Set = набір унікальних значень. Тут: функції, яких сповіщаємо про стан з'єднання.
  const statusListeners = new Set();
  // Повідомлення, надіслані поки сокет не готовий; підуть після підключення.
  const queue = [];
  // Коди закриття, після яких перепідключення безглузде (збігаються з CLOSE на сервері):
  // 1009 завелике повідомлення, 4001 BAD_FORMAT, 4002 UNKNOWN_TYPE,
  // 4004 NOT_JOINED, 4005 ROOM_NOT_FOUND.
  const FATAL_CODES = new Set([1009, 4001, 4002, 4004, 4005]);
  // Максимум повідомлень у черзі, щоб вона не росла безкінечно.
  const MAX_QUEUE = 100;
  // Поточний WebSocket; спочатку його немає (null = "порожньо").
  let socket = null;
  // Скільки невдалих спроб підряд (від цього залежить пауза).
  let attempt = 0;
  // Таймер перепідключення; зберігаємо, щоб його можна було скасувати.
  let timer = null;
  // true, якщо ми самі закрили з'єднання, тоді повторно не підключаємось.
  let closedByUser = false;
  // Функція, що повертає повідомлення join; викликається при КОЖНОМУ відкритті.
  let hello = null;

  // Повідомляє слухачів про стан ("connecting", "open", "closed"); code лише для "closed".
  function setStatus(state, code) {
    // for...of перебирає елементи набору по одному.
    for (const fn of statusListeners) fn(state, code);
  }

  // Надсилає об'єкт одразу: додає версію й перетворює в JSON-рядок.
  function rawSend(msg) {
    // ...msg розгортає поля повідомлення в новий об'єкт; v іде першим.
    socket.send(JSON.stringify({ v: PROTOCOL_VERSION, ...msg }));
  }

  // Рахує паузу перед наступною спробою й планує її.
  function scheduleReconnect() {
    // 2 ** attempt = 1, 2, 4, 8... Множимо на 1 с; більше 15 с не чекаємо.
    const base = Math.min(1000 * 2 ** attempt, 15000);
    // Jitter: випадкова добавка, щоб усі клієнти не стукали в сервер одночасно.
    const delay = base / 2 + (Math.random() * base) / 2;
    // Запам'ятовуємо, що була ще одна спроба.
    attempt += 1;
    // setTimeout викличе connect через delay мілісекунд.
    timer = setTimeout(connect, delay);
  }

  // Створює нове з'єднання.
  function connect() {
    // Раз викликали connect, ми знову хочемо бути підключеними.
    closedByUser = false;
    // Сповіщаємо інтерфейс, що почали підключатись.
    setStatus("connecting");
    // Браузерний вбудований WebSocket.
    socket = new WebSocket(url);

    // Подія "open": з'єднання встановлено.
    socket.addEventListener("open", () => {
      // Успіх: скидаємо лічильник невдач.
      attempt = 0;
      // Спершу join, бо сервер чекає його першим повідомленням.
      if (hello) rawSend(hello());
      // Потім відправляємо все, що накопичилось у черзі.
      while (queue.length > 0) rawSend(queue.shift());
      // Сповіщаємо інтерфейс, що ми онлайн.
      setStatus("open");
    });

    // Подія "message": прийшло повідомлення від сервера.
    socket.addEventListener("message", (event) => {
      // Змінна для розібраного повідомлення.
      let msg;
      try {
        // event.data це рядок; JSON.parse перетворює його назад в об'єкт.
        msg = JSON.parse(event.data);
      } catch {
        // Якщо прийшов не JSON, ігноруємо.
        return;
      }
      // Перевіряємо форму: має бути об'єкт з текстовим type.
      if (!msg || typeof msg.type !== "string") return;
      // Дістаємо обробників саме цього типу.
      const set = handlers.get(msg.type);
      // Якщо вони є, викликаємо кожного й передаємо повідомлення.
      if (set) for (const fn of set) fn(msg);
    });

    // Подія "error": деталей браузер не дає, "close" прийде одразу після неї.
    socket.addEventListener("error", () => {
      console.warn("WebSocket error");
    });

    // Подія "close": з'єднання закрилось (сервером, мережею чи нами).
    socket.addEventListener("close", (event) => {
      // Передаємо стан і код, щоб інтерфейс міг пояснити причину.
      setStatus("closed", event.code);
      // Не перепідключаємось, якщо закрили самі або сервер нас відхилив.
      if (closedByUser || FATAL_CODES.has(event.code)) return;
      // Інакше пробуємо ще раз із паузою.
      scheduleReconnect();
    });
  }

  // Надсилає повідомлення: одразу, якщо сокет готовий, інакше в чергу.
  function send(msg) {
    // readyState === OPEN означає, що сокет готовий до відправки.
    if (socket && socket.readyState === WebSocket.OPEN) {
      rawSend(msg);
    } else {
      // Якщо черга повна, викидаємо найстаріше.
      if (queue.length >= MAX_QUEUE) queue.shift();
      // Додаємо повідомлення в кінець черги.
      queue.push(msg);
    }
  }

  // Підписка на повідомлення певного типу; повертає функцію "відписатись".
  function on(type, fn) {
    // Якщо для цього типу ще немає набору, створюємо.
    if (!handlers.has(type)) handlers.set(type, new Set());
    // Додаємо обробника.
    handlers.get(type).add(fn);
    // Повертаємо функцію, яка прибирає цього обробника.
    return () => handlers.get(type).delete(fn);
  }

  // Підписка на зміни стану з'єднання.
  function onStatus(fn) {
    statusListeners.add(fn);
  }

  // Задає, яке повідомлення join слати після кожного (пере)підключення.
  function setHello(fn) {
    hello = fn;
  }

  // Закриває з'єднання остаточно.
  function close() {
    // Позначаємо, що перепідключення не потрібне.
    closedByUser = true;
    // Скасовуємо заплановану спробу, якщо вона є.
    clearTimeout(timer);
    // ?. означає "якщо socket існує"; 1000 це код нормального закриття.
    socket?.close(1000);
  }

  // Повертаємо "публічний інтерфейс" обгортки.
  return { connect, send, on, onStatus, setHello, close };
}