// Замір перевіряє потокове відтворення великого журналу повільному клієнту.
import { spawn } from 'node:child_process'; // Окремий процес ізолює RSS HTTP-сервера від клієнта.
import { createWriteStream } from 'node:fs'; // Потік створює тестовий файл без буфера на 200 MiB.
import { mkdir, unlink, writeFile } from 'node:fs/promises'; // Файлові операції очікуються без блокування event loop.
import http from 'node:http'; // Вбудований клієнт надсилає запит до тестового сервера.
import path from 'node:path'; // Шляхи будуються сумісно з Windows і POSIX.
import { once } from 'node:events'; // once очікує готовності дочірнього процесу.
import { Writable } from 'node:stream'; // Writable моделює повільного споживача даних.
import { fileURLToPath } from 'node:url'; // Перетворює URL цього модуля на шлях для spawn.
import { config } from '../src/config.js'; // Використовуємо ту саму папку логів, що й сервер.
import { streamMatchLog } from '../src/logger.js'; // Вимірюємо production-функцію потокового повтору.

const scriptPath = fileURLToPath(import.meta.url); // Зберігаємо адресу цього сценарію для дочірнього запуску.
const roomId = process.argv[2] === '--server' ? process.argv[3] : 'bench-' + process.pid; // Передаємо один ID обом процесам.
const reportDirectory = path.dirname(scriptPath); // Звіти зберігаються поруч із цим сценарієм.
const filePrefix = roomId + '-'; // Префікс допомагає знайти лише файл, створений поточним запуском.
const targetBytes = 200 * 1024 * 1024; // Вимога лабораторної задає журнал на 200 MiB.
const record = Buffer.from(JSON.stringify({ type: 'benchmark', payload: 'x'.repeat(900) }) + '\n'); // Один NDJSON-рядок повторюється без накопичення в RAM.

// Створюємо великий журнал через backpressure дискового потоку.
async function createLargeLog() {
  await mkdir(config.LOG_DIR, { recursive: true }); // Гарантуємо наявність папки журналів.
  const filePath = path.join(config.LOG_DIR, filePrefix + 'replay.ndjson'); // Формуємо шлях для room ID, який перевіряє logger.
  const output = createWriteStream(filePath, { highWaterMark: 64 * 1024 }); // Обмежуємо буфер запису 64 KiB.
  let bytes = 0; // Рахуємо байти, записані в тестовий файл.
  while (bytes < targetBytes) {
    // Пишемо записи, доки файл не перетне 200 MiB.
    bytes += record.length; // Враховуємо розмір одного NDJSON-запису.
    if (!output.write(record)) await once(output, 'drain'); // Зупиняємо генератор, якщо диск не встигає.
  } // Завершуємо обмежений цикл генерації.
  output.end(); // Сигналізуємо потоку, що більше даних не буде.
  await once(output, 'close'); // Чекаємо, поки файл повністю закриється.
  return filePath; // Повертаємо точний шлях для подальшого очищення.
} // Завершуємо потокове створення логу.

// Дочірній процес виконує серверну частину та повідомляє свій RSS через IPC.
async function runServerProcess() {
  const server = http.createServer(async (request, response) => {
    // Створюємо мінімальний HTTP сервер для production-функції.
    const pathname = new URL(request.url, 'http://localhost').pathname; // Розбираємо URL запиту.
    if (pathname !== '/api/replays/' + roomId) {
      response.writeHead(404).end();
      return;
    } // Дозволяємо лише запит нашого тестового ID.
    const streamed = await streamMatchLog(roomId, response); // Віддаємо файл через pipeline із backpressure.
    if (!streamed && !response.headersSent) response.writeHead(404).end(); // Повідомляємо про відсутній файл.
  }); // Завершуємо обробник HTTP.
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); // Вибираємо вільний локальний порт.
  const address = server.address(); // Читаємо фактичний порт після listen.
  let startedAt = null; // Час початку відліку RSS задається разом із першим запитом.
  const sampler = setInterval(() => {
    // Періодично записуємо пам'ять саме дочірнього сервера.
    if (startedAt !== null)
      process.send({ type: 'sample', elapsedMs: performance.now() - startedAt, rss: process.memoryUsage().rss }); // Відправляємо RSS батьківському процесу.
  }, 250); // Знімаємо одне значення кожні 250 мс.
  sampler.unref(); // Таймер не заважає штатному завершенню процесу.
  server.prependListener('request', () => {
    if (startedAt === null) startedAt = performance.now();
  }); // Починаємо графік з першого запиту клієнта.
  process.send({ type: 'ready', port: address.port, rss: process.memoryUsage().rss }); // Повідомляємо адресу та початкову пам'ять.
  process.on('message', async (message) => {
    // Очікуємо команду зупинки після завершення клієнта.
    if (message?.type !== 'stop') return; // Ігноруємо невідомі службові команди.
    clearInterval(sampler); // Зупиняємо опитування пам'яті.
    await new Promise((resolve) => server.close(resolve)); // Закриваємо HTTP-сервер після останньої відповіді.
    process.send({ type: 'stopped' }); // Підтверджуємо завершення батьківському процесу.
    process.disconnect(); // Закриваємо IPC-канал, щоб дочірній процес міг завершитися.
  }); // Завершуємо IPC-обробник.
} // Завершуємо серверний режим.

// Читаємо відповідь повільно, щоб примусити сервер дотримуватися backpressure.
async function downloadSlowly(port) {
  const received = new Writable({
    // Створюємо обмежений за пам'яттю приймач.
    highWaterMark: 64 * 1024, // Передаємо зворотний тиск після невеликого буфера.
    write(chunk, encoding, callback) {
      // Обробляємо кожен фрагмент окремо.
      setTimeout(callback, 3); // Затримка імітує повільний канал приблизно на кожен 64 KiB блок.
    }, // Завершуємо повільний запис.
  }); // Завершуємо клієнтський потік.
  const response = await new Promise((resolve, reject) => {
    // Очікуємо заголовки HTTP відповіді.
    const request = http.get({ hostname: '127.0.0.1', port, path: '/api/replays/' + roomId }, resolve); // Завантажуємо саме маршрут повтору.
    request.on('error', reject); // Передаємо помилки з'єднання виклику.
  }); // Завершуємо встановлення HTTP запиту.
  if (response.statusCode !== 200) throw new Error('Replay returned HTTP ' + response.statusCode); // Не приймаємо помилковий маршрут як успіх.
  let bytes = 0; // Рахуємо отримані байти для перевірки повного завантаження.
  response.on('data', (chunk) => {
    bytes += chunk.length;
  }); // Лічильник не зберігає самі фрагменти.
  await new Promise((resolve, reject) => {
    // Чекаємо повного споживання відповіді.
    received.on('finish', resolve); // Writable завершується лише після останнього фрагмента.
    received.on('error', reject); // Помилка приймача завершує замір.
    response.on('error', reject); // Помилка мережевого потоку теж має бути видимою.
    response.pipe(received); // pipe автоматично призупиняє джерело при backpressure.
  }); // Завершуємо повільне завантаження.
  return bytes; // Повертаємо контрольну кількість отриманих байтів.
} // Завершуємо імітацію повільного клієнта.

// Перетворюємо вимірювання в CSV і самодостатній SVG-графік.
async function saveReport(samples, bytes) {
  const base = samples[0]?.rss ?? 0; // Перша точка задає початкову пам'ять сервера.
  const values = samples.map((sample) => sample.rss / 1024 / 1024); // Переводимо байти в MiB для читабельного графіка.
  const minValue = Math.min(...values); // Знаходимо нижню межу шкали RSS.
  const maxValue = Math.max(...values); // Знаходимо верхню межу шкали RSS.
  const range = Math.max(maxValue - minValue, 1); // Даємо графіку мінімальний вертикальний масштаб.
  const points = samples.map((sample, index) => {
    // Перетворюємо кожне вимірювання у координати SVG.
    const x = 60 + (index / Math.max(samples.length - 1, 1)) * 800; // Розтягуємо вимірювання по ширині графіка.
    const y = 300 - ((sample.rss / 1024 / 1024 - minValue) / range) * 220; // Розміщуємо RSS по вертикальній шкалі.
    return x.toFixed(1) + ',' + y.toFixed(1); // Форматуємо SVG координату.
  }); // Завершуємо створення точок.
  const durationMs = samples.at(-1)?.elapsedMs ?? 0; // Останнє вимірювання задає довжину завантаження.
  const csv = [
    'elapsed_ms,rss_mib',
    ...samples.map((sample) => sample.elapsedMs.toFixed(0) + ',' + (sample.rss / 1024 / 1024).toFixed(2)),
  ].join('\n'); // Зберігаємо повний набір точок.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="360" viewBox="0 0 900 360"><rect width="900" height="360" fill="#10151c"/><text x="60" y="30" fill="#e8edf2" font-family="sans-serif" font-size="18">RSS сервера під час повільного replay (200 MiB)</text><path d="M60 300H860 M60 80V300" stroke="#607080" fill="none"/><polyline points="${points.join(' ')}" fill="none" stroke="#66fcf1" stroke-width="3"/><text x="60" y="330" fill="#e8edf2" font-family="sans-serif" font-size="13">0 с</text><text x="820" y="330" fill="#e8edf2" font-family="sans-serif" font-size="13">${(durationMs / 1000).toFixed(1)} с</text><text x="8" y="86" fill="#e8edf2" font-family="sans-serif" font-size="12">${maxValue.toFixed(1)} MiB</text><text x="8" y="300" fill="#e8edf2" font-family="sans-serif" font-size="12">${minValue.toFixed(1)} MiB</text><text x="60" y="352" fill="#8da2b5" font-family="sans-serif" font-size="12">Отримано ${Math.round(bytes / 1024 / 1024)} MiB · старт ${(base / 1024 / 1024).toFixed(1)} MiB · розкид ${(maxValue - minValue).toFixed(1)} MiB</text></svg>`; // Будуємо незалежний графік без додаткової бібліотеки.
  await mkdir(reportDirectory, { recursive: true }); // Гарантуємо папку для звітів.
  await writeFile(path.join(reportDirectory, 'rss.csv'), csv + '\n'); // Записуємо сирі дані для перевірки графіка.
  await writeFile(path.join(reportDirectory, 'rss.svg'), svg); // Записуємо векторний графік для README.
  return {
    bytes,
    durationMs,
    startRss: base,
    minRss: Math.min(...samples.map((sample) => sample.rss)),
    maxRss: Math.max(...samples.map((sample) => sample.rss)),
    samples: samples.length,
  }; // Повертаємо стислий результат вимірювання.
} // Завершуємо збереження звіту.

// Батьківський режим готує журнал, запускає сервер і зберігає результат.
async function runBenchmark() {
  const filePath = await createLargeLog(); // Створюємо 200 MiB послідовно через дисковий потік.
  const child = spawn(process.execPath, [scriptPath, '--server', roomId], {
    cwd: process.cwd(),
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  }); // Запускаємо ізольований процес HTTP-сервера.
  const samples = []; // Тут зберігаються лише малі числові точки RSS.
  try {
    // Гарантуємо очищення тимчасового журналу навіть у разі помилки.
    const [ready] = await once(child, 'message'); // Чекаємо, поки дочірній HTTP-сервер почне слухати.
    if (ready?.type !== 'ready') throw new Error('Benchmark server did not become ready'); // Перевіряємо протокол запуску.
    samples.push({ elapsedMs: 0, rss: ready.rss }); // Додаємо початкове значення RSS до графіка.
    child.on('message', (message) => {
      if (message?.type === 'sample') samples.push(message);
    }); // Збираємо виміри, що надсилає сервер.
    const bytes = await downloadSlowly(ready.port); // Передаємо файл клієнту з навмисною затримкою.
    child.send({ type: 'stop' }); // Просимо дочірній сервер закрити сокети та завершитися.
    await once(child, 'exit'); // Чекаємо завершення процесу після закриття сервера.
    const summary = await saveReport(samples, bytes); // Формуємо CSV і SVG з отриманих точок.
    process.stdout.write(JSON.stringify(summary, null, 2) + '\n'); // Друкуємо точні значення для README.
  } finally {
    // Завжди прибираємо тільки файл, який створив цей сценарій.
    if (child.exitCode === null) child.kill(); // Зупиняємо дочірній процес, якщо виникла помилка.
    await unlink(filePath).catch(() => {}); // Видаляємо власний тимчасовий файл replay.
  } // Завершуємо безпечне очищення.
} // Завершуємо benchmark.

if (process.argv[2] === '--server')
  await runServerProcess(); // Дочірній процес запускає лише серверну половину.
else await runBenchmark(); // Звичайний запуск створює лог, клієнта та звіт.
