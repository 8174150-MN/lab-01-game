// Збираємо читання параметрів середовища в одному місці до запуску сервера.
import path from 'node:path'; // Формуємо шляхи логів і збірки для поточної ОС.

function readInteger(name, fallback, min, max) {
  const raw = process.env[name]; // Зчитуємо вказану змінну середовища один раз.
  if (raw === undefined || raw.trim() === '') return fallback; // Використовуємо стандартне значення, якщо параметр не задано.
  const value = Number(raw); // Перетворюємо весь рядок на число, не приймаючи лише його початок.
  if (!Number.isInteger(value) || value < min || value > max)
    throw new RangeError(name + ' must be an integer from ' + min + ' to ' + max); // Зупиняємо запуск, якщо значення некоректне.
  return value; // Повертаємо лише перевірене ціле число.
} // Завершуємо суворе читання цілого числа.

const hostValue = process.env.HOST?.trim() || '0.0.0.0'; // Слухаємо всі мережеві інтерфейси, якщо адміністратор не вказав інший.
const logValue = process.env.LOG_DIR?.trim() || './logs'; // За замовчуванням зберігаємо журнали в папці проєкту.
if (hostValue.includes(' ')) throw new Error('HOST cannot contain spaces'); // Відхиляємо некоректне ім'я вузла ще до запуску.
if (logValue.includes('\0')) throw new Error('LOG_DIR cannot contain a null byte'); // Відхиляємо шлях із недопустимим нульовим символом.

export const config = Object.freeze({
  PORT: readInteger('PORT', 3000, 0, 65535), // Дозволяємо порт 0 для вибору вільного порту під час локальних тестів.
  HOST: hostValue, // HTTP-сервер прив'язується до перевіреного вузла.
  LOG_DIR: path.resolve(logValue), // Перетворюємо відносну адресу логів на абсолютний шлях.
  DIST_DIR: path.resolve(import.meta.dirname, '../../client/dist'), // Вказуємо папку зі зібраними Vite файлами.
  MAX_BODY_BYTES: readInteger('MAX_BODY_BYTES', 65536, 1024, 1048576), // Обмежуємо розмір JSON тіла HTTP-запиту.
  MAX_ROOMS: readInteger('MAX_ROOMS', 20, 1, 1000), // Обмежуємо кількість кімнат у процесі.
  MAX_PLAYERS_PER_ROOM: readInteger('MAX_PLAYERS_PER_ROOM', 10, 1, 100), // Обмежуємо кількість сокетів в одній кімнаті.
  MAX_MESSAGE_BYTES: readInteger('MAX_MESSAGE_BYTES', 2048, 64, 65536), // Обмежуємо розмір WebSocket-повідомлення.
  MAX_MESSAGES_PER_SECOND: readInteger('MAX_MESSAGES_PER_SECOND', 120, 1, 1000), // Залишаємо запас понад 30 input-пакетів/с плюс ping та chat.
  ENABLE_DEMOS: process.env.ENABLE_DEMOS !== 'false', // Вмикаємо локальні навчальні маршрути, якщо їх явно не вимкнули.
}); // Захищаємо перевірені параметри від випадкової зміни під час роботи.
