// Версія протоколу: клієнт і сервер мусять її збігатися
export const PROTOCOL_VERSION = 1;
// Максимальний розмір одного повідомлення в байтах (віддамо бібліотеці ws як maxPayload)
export const MAX_MESSAGE_BYTES = 2048;

// Коди закриття сокета; діапазон 4000–4999 стандарт віддає для власних потреб
export const CLOSE = Object.freeze({
  // Зламаний JSON, неправильна форма або версія
  BAD_FORMAT: 4001,
  // Тип повідомлення, якого ми не знаємо
  UNKNOWN_TYPE: 4002,
  // Клієнт не надіслав join за 5 секунд
  JOIN_TIMEOUT: 4003,
  // Клієнт шле чат, не зайшовши в кімнату
  NOT_JOINED: 4004,
  // Кімнати з таким id немає
  ROOM_NOT_FOUND: 4005,
  // Зарезервовано для rate limit (M4)
  RATE_LIMIT: 4006,
});

// Хелпер: результат "помилка" з кодом закриття і коротким поясненням
const fail = (code, reason) => ({ ok: false, code, reason });
// Хелпер: результат "успіх" з очищеним повідомленням
const ok = (msg) => ({ ok: true, msg });

// Перевіряє рядок: має бути string довжиною min..max після trim, інакше null
function cleanString(value, min, max) {
  // Не рядок — одразу відмова
  if (typeof value !== "string") return null;
  // Прибираємо пробіли по краях
  const s = value.trim();
  // Занадто коротко або задовго — відмова
  if (s.length < min || s.length > max) return null;
  // Повертаємо чистий рядок
  return s;
}

// Головна функція: перевіряє сирий текст повідомлення клієнта
export function validate(text) {
  // Тут буде розібраний об'єкт
  let msg;
  try {
    // Пробуємо розібрати JSON
    msg = JSON.parse(text);
  } catch {
    // Не JSON — закриваємо з BAD_FORMAT
    return fail(CLOSE.BAD_FORMAT, "bad json");
  }
  // Має бути саме об'єкт (не null, не масив, не число)
  if (typeof msg !== "object" || msg === null || Array.isArray(msg)) {
    return fail(CLOSE.BAD_FORMAT, "bad shape");
  }
  // Версія має збігатися з нашою
  if (msg.v !== PROTOCOL_VERSION) return fail(CLOSE.BAD_FORMAT, "bad version");
  // type обов'язково рядок
  if (typeof msg.type !== "string") return fail(CLOSE.BAD_FORMAT, "bad type");

  // Далі поведінка залежить від типу
  switch (msg.type) {
    // Вхід у кімнату: { v, type:"join", room, name }
    case "join": {
      // id кімнати: 1..64 символи
      const room = cleanString(msg.room, 1, 64);
      // Ім'я гравця: 1..24 символи
      const name = cleanString(msg.name, 1, 24);
      // Якщо щось не пройшло — відмова
      if (!room || !name) return fail(CLOSE.BAD_FORMAT, "bad join");
      // Повертаємо НОВИЙ об'єкт лише з відомими полями (білий список)
      return ok({ type: "join", room, name });
    }
    // Повідомлення чату: { v, type:"chat", text }
    case "chat": {
      // Текст: 1..500 символів
      const text = cleanString(msg.text, 1, 500);
      // Порожній або задовгий — відмова
      if (!text) return fail(CLOSE.BAD_FORMAT, "bad chat");
      // Знову лише відомі поля
      return ok({ type: "chat", text });
    }
    // Будь-який інший тип нам невідомий
    default:
      return fail(CLOSE.UNKNOWN_TYPE, "unknown type");
  }
}