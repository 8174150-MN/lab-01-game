// Події матчу проходять через Transform у режимі об'єктів і потік до файла.
import { createReadStream, createWriteStream } from 'node:fs'; // Файлові потоки не завантажують увесь журнал у пам'ять.
import { readdir } from 'node:fs/promises'; // Шукаємо у папці найновіший файл повтору.
import path from 'node:path'; // Формуємо шляхи без помилок роздільників ОС.
import { PassThrough, Transform } from 'node:stream'; // Джерело приймає об'єкти, а Transform серіалізує їх.
import { once } from 'node:events'; // once чекає, поки потік Writable зможе приймати дані.
import { pipeline } from 'node:stream/promises'; // pipeline передає помилки й враховує backpressure.
import { config } from './config.js'; // Перевірена конфігурація задає LOG_DIR.

function safeRoomId(roomId) {
  return /^[a-zA-Z0-9_-]{1,64}$/.test(roomId);
} // Лише згенеровані ID кімнат можуть ставати частиною шляху до логу.

export function createMatchLogger(roomId) {
  if (!safeRoomId(roomId)) throw new Error('Invalid room id for match log'); // Не дозволяємо роздільники шляху в ID кімнати.
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-'); // Формуємо мітку часу, безпечну для імені файла.
  const filename = path.join(config.LOG_DIR, roomId + '-' + timestamp + '.ndjson'); // Зберігаємо журнал кімнати всередині LOG_DIR.
  const source = new PassThrough({ objectMode: true, highWaterMark: 16 }); // Обмежуємо чергу об'єктів до Transform.
  const serializer = new Transform({
    writableObjectMode: true,
    transform(event, encoding, callback) {
      callback(null, JSON.stringify(event) + '\n');
    },
  }); // Перетворюємо кожен об'єкт на один рядок NDJSON.
  const destination = createWriteStream(filename, { flags: 'a' }); // Додаємо серіалізовані записи в кінець файла.
  let closed = false; // Забороняємо нові записи після початку закриття.
  let pipelineError = null; // Зберігаємо помилку потоку для наступних викликів log.
  const completion = pipeline(source, serializer, destination); // З'єднуємо джерело, серіалізатор і файл із backpressure.
  completion.catch((error) => {
    pipelineError = error;
  }); // Одразу підписуємося на помилку й зберігаємо її причину.

  // Записуємо одну подію та чекаємо, якщо потік повідомив про backpressure.
  async function log(type, data = {}) {
    if (closed) throw new Error('Match log is already closed'); // Не приймаємо записи після закриття журналу.
    if (pipelineError) throw pipelineError; // Повертаємо попередню помилку диска або Transform.
    const record = { at: new Date().toISOString(), type, ...data }; // Додаємо час ISO та тип події.
    if (!source.write(record)) await once(source, 'drain'); // Призупиняємо викликач, доки потік не звільнить буфер.
  } // Завершуємо запис однієї події.

  // Закриваємо джерело й очікуємо, поки pipeline допише файл.
  async function close() {
    if (!closed) {
      closed = true;
      source.end();
    } // Надсилаємо сигнал завершення лише один раз.
    await completion; // Завершуємося після збереження даних і закриття файла.
  } // Завершуємо коректне закриття потоку.

  return { filename, log, close }; // Віддаємо Room невеликий інтерфейс для запису й закриття.
} // Завершуємо створення журналу матчу.

async function findLogFile(roomId) {
  if (!safeRoomId(roomId)) return null; // Не дозволяємо вийти з папки через ID повтору.
  const files = await readdir(config.LOG_DIR); // Читаємо лише імена, а не вміст журналів.
  const matches = files.filter((name) => name.startsWith(roomId + '-') && name.endsWith('.ndjson')).sort(); // Знаходимо файли кімнати й сортуємо за часом.
  return matches.length ? path.join(config.LOG_DIR, matches[matches.length - 1]) : null; // Найновіша мітка ISO сортується після старих.
} // Завершуємо безпечний пошук журналу.

export async function* iterateMatchLog(roomId) {
  const filename = await findLogFile(roomId); // Знаходимо перевірений шлях до журналу кімнати.
  if (!filename) return; // Відсутній replay повертає порожній асинхронний ітератор.
  const stream = createReadStream(filename, { encoding: 'utf8' }); // Читаємо текст із диска частинами.
  let remainder = ''; // Зберігаємо лише незакінчений рядок між частинами.
  for await (const chunk of stream) {
    // Асинхронний for-await читає наступну частину, коли вона доступна.
    const lines = (remainder + chunk).split('\n'); // Відділяємо завершені рядки NDJSON.
    remainder = lines.pop(); // Залишаємо лише можливий незавершений запис.
    for (const line of lines) if (line.trim()) yield JSON.parse(line); // Розбираємо й повертаємо кожен повний запис.
  } // Завершуємо передавання всіх частин.
  if (remainder.trim()) yield JSON.parse(remainder); // Повертаємо останній рядок, навіть без символу нового рядка.
} // Завершуємо ітератор повтору.

export async function streamMatchLog(roomId, response) {
  const filename = await findLogFile(roomId); // Знаходимо файл, не завантажуючи його в пам'ять.
  if (!filename) return false; // Дозволяємо HTTP-рівню відповісти статусом 404.
  response.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store' }); // Описуємо тип потоку й забороняємо кеш.
  await pipeline(createReadStream(filename), response); // Передаємо файл частинами з backpressure клієнта.
  return true; // Підтверджуємо, що відповідь була надіслана.
} // Завершуємо потокову передачу повтору.
