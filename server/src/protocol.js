// Сервер і браузер використовують цей компактний версійований JSON протокол.
export const PROTOCOL_VERSION = 1; // Змінюй номер, якщо зміниться формат повідомлень.
export const CLOSE = Object.freeze({
  BAD_FORMAT: 4001,
  UNKNOWN_TYPE: 4002,
  JOIN_TIMEOUT: 4003,
  NOT_JOINED: 4004,
  ROOM_NOT_FOUND: 4005,
  RATE_LIMIT: 4006,
  ROOM_FULL: 4007,
}); // Іменовані коди роблять причини закриття сокета зрозумілими.

function failure(code, reason) {
  return { ok: false, code, reason };
} // Повертаємо помилку перевірки в єдиному форматі.
function success(message) {
  return { ok: true, message };
} // Повертаємо лише перевірене повідомлення з дозволеними полями.
function hasOnlyKeys(message, allowed) {
  return Object.keys(message).every((key) => allowed.includes(key));
} // Відхиляємо поля, яких протокол не описує.
function cleanString(value, min, max) {
  if (typeof value !== 'string') return null; // Не приймаємо число чи інший тип замість рядка.
  const result = value.trim();
  return result.length >= min && result.length <= max ? result : null;
} // Обрізаємо пробіли й перевіряємо довжину рядкового поля.

export function validateMessage(raw) {
  let message; // Оголошуємо змінну до try, щоб бачити її після парсингу.
  try {
    message = JSON.parse(raw);
  } catch {
    return failure(CLOSE.BAD_FORMAT, 'invalid JSON');
  } // Пошкоджений JSON не є повідомленням протоколу.
  if (!message || typeof message !== 'object' || Array.isArray(message))
    return failure(CLOSE.BAD_FORMAT, 'message must be an object'); // Вимагаємо звичайний об'єкт як форму повідомлення.
  if (message.v !== PROTOCOL_VERSION) return failure(CLOSE.BAD_FORMAT, 'unsupported protocol version'); // Відхиляємо клієнта з іншою версією.
  if (typeof message.type !== 'string') return failure(CLOSE.BAD_FORMAT, 'type must be a string'); // Вимагаємо рядкове поле type.
  if (message.type === 'join') {
    // Перевіряємо вхід до кімнати окремо від повідомлення чату.
    if (!hasOnlyKeys(message, ['v', 'type', 'room', 'name'])) return failure(CLOSE.BAD_FORMAT, 'unexpected join field'); // Відхиляємо зайві поля.
    const room = cleanString(message.room, 1, 64); // ID кімнати має бути непорожнім і коротким.
    const name = cleanString(message.name, 1, 24); // Обмежуємо ім'я для чату й списку учасників.
    if (!room || !name) return failure(CLOSE.BAD_FORMAT, 'invalid join fields'); // Обидва поля обов'язкові.
    return success({ type: 'join', room, name }); // Повертаємо лише дані, які використовує сервер.
  } // Завершуємо перевірку входу.
  if (message.type === 'chat') {
    // Перевіряємо структуру повідомлення чату.
    if (!hasOnlyKeys(message, ['v', 'type', 'text'])) return failure(CLOSE.BAD_FORMAT, 'unexpected chat field'); // Відхиляємо незадокументовані дані клієнта.
    const text = cleanString(message.text, 1, 500); // Обмежуємо довжину й відхиляємо повідомлення з самих пробілів.
    if (!text) return failure(CLOSE.BAD_FORMAT, 'invalid chat text'); // Вимагаємо непорожній текст.
    return success({ type: 'chat', text }); // Повертаємо лише дозволений вміст чату.
  } // Завершуємо перевірку чату.
  return failure(CLOSE.UNKNOWN_TYPE, 'unknown message type'); // Закриваємо сокет замість мовчазного ігнорування невідомого типу.
} // Завершуємо перевірку протоколу.
