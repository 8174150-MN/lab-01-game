// Headless clients send the exact same binary InputCommand frames as the browser client.
import { writeFile } from 'node:fs/promises'; // Зберігаємо справжні результати та графік після запуску.
import { performance } from 'node:perf_hooks'; // Міряємо проміжки серверних snapshot у монотонному часі.
import WebSocket from 'ws'; // Створюємо клієнтів без браузерного вікна.
import { serializeInput } from '@dogfight/shared/protocol'; // Кодуємо той самий протокол, що й клієнтська гра.
import { asSeq } from '@dogfight/shared/types'; // Перетворюємо лічильник на branded seq.
import type { InputCommand } from '@dogfight/shared/types'; // Типізуємо команди ботів.

interface RoomInfo {
  readonly id: string;
  readonly name: string;
  readonly maxPlayers: number;
}

interface Bot {
  readonly socket: WebSocket;
  readonly snapshotIntervals: number[];
  lastSnapshotAt: number;
  bytesReceived: number;
  bytesSent: number;
}

interface LoadResult {
  readonly clients: number;
  readonly durationMs: number;
  readonly tickP50Ms: number;
  readonly tickP95Ms: number;
  readonly tickP99Ms: number;
  readonly tickMaxMs: number;
  readonly ticksOver33Ms: number;
  readonly snapshotGapP95Ms: number;
  readonly eventLoopUtilization: number;
  readonly rssStartMiB: number;
  readonly rssEndMiB: number;
  readonly rssPeakMiB: number;
  readonly uploadBytesPerSecond: number;
  readonly downloadBytesPerSecond: number;
  readonly totalBytesPerSecond: number;
}

interface ServerRuntimeStats {
  readonly rssBytes: number;
  readonly eventLoopActiveMs: number;
  readonly eventLoopIdleMs: number;
}

const serverUrl = new URL(process.env.SERVER_URL ?? 'http://127.0.0.1:3000'); // За потреби дозволяємо вказати інший сервер.
const websocketUrl = 'ws://' + serverUrl.host + '/ws'; // Перетворюємо HTTP origin на WebSocket endpoint.
const supportedClientCounts = [8, 32, 64, 128]; // Перевіряємо рівні навантаження з вимоги лабораторної.
const clientsArgument = process.argv.find((argument) => argument.startsWith('--clients=')); // Дозволяємо окремо запустити легкий тест із вісьмома ботами.
const requestedClientCount = clientsArgument ? Number(clientsArgument.split('=')[1]) : null; // Перетворюємо явно задане число клієнтів.
if (requestedClientCount !== null && !supportedClientCounts.includes(requestedClientCount))
  throw new RangeError('Use --clients=8, 32, 64, or 128'); // Не запускаємо випадкове або надмірне навантаження.
const clientCounts = requestedClientCount === null ? supportedClientCounts : [requestedClientCount]; // Без прапорця запускаємо всі чотири рівні.
const durationArgument = process.argv.find((argument) => argument.startsWith('--duration=')); // Дозволяємо коротший вимір для слабкого ноутбука.
const requestedDuration = Number(durationArgument?.split('=')[1] ?? 2500); // Зчитуємо тривалість кожного рівня навантаження.
if (!Number.isFinite(requestedDuration) || requestedDuration < 500 || requestedDuration > 120_000)
  throw new RangeError('Use --duration between 500 and 120000 milliseconds'); // Обмежуємо тривалість і відхиляємо NaN.
const durationMs = requestedDuration; // Зберігаємо перевірену тривалість сценарію.

// Перевіряємо невідоме JSON-значення перед читанням полів.
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value); // null і масив не є JSON-записами кімнати.
} // Завершуємо перевірку JSON-запису.

// Обчислюємо процентиль зі скопійованих і відсортованих вимірів.
function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0; // Порожня вибірка не має вимірюваного часу.
  const sorted = [...values].sort((a, b) => a - b); // Не змінюємо порядок вихідних замірів.
  const index = Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1); // Обираємо найближчий ранг угору.
  return sorted[index] ?? 0; // Повертаємо точку процентиля або нуль для порожнього буфера.
} // Завершуємо обчислення процентиля.

// Підраховуємо байти, не копіюючи WebSocket-повідомлення.
function rawDataLength(data: Buffer | ArrayBuffer | Buffer[]): number {
  if (Array.isArray(data)) return data.reduce((total, part) => total + part.byteLength, 0); // ws може повернути фрагменти окремими Buffer.
  return data.byteLength; // Buffer та ArrayBuffer уже надають довжину в байтах.
} // Завершуємо підрахунок довжини повідомлення.

// Створюємо одну серверну кімнату через той самий API, що використовує лобі.
async function createRoom(name: string): Promise<RoomInfo> {
  const response = await fetch(new URL('/api/rooms', serverUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  }); // Створюємо кімнату без доступу до внутрішнього RoomManager.
  if (!response.ok) throw new Error('Could not create load-test room: HTTP ' + response.status); // Пояснюємо, якщо досягнуто ліміт кімнат.
  const body: unknown = await response.json(); // Вважаємо тіло відповіді недовіреним.
  if (
    !isRecord(body) ||
    typeof body.id !== 'string' ||
    typeof body.name !== 'string' ||
    typeof body.maxPlayers !== 'number'
  )
    throw new Error('Room API returned an invalid room'); // Перевіряємо поля перед використанням.
  return { id: body.id, name: body.name, maxPlayers: body.maxPlayers }; // Повертаємо тільки потрібні значення.
} // Завершуємо створення кімнати.

// Відкриваємо WebSocket-клієнта та приєднуємо його до заданої кімнати.
function connectBot(room: RoomInfo, name: string): Promise<Bot> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(websocketUrl); // Підключаємося тим самим транспортом, що браузер.
    const bot: Bot = { socket, snapshotIntervals: [], lastSnapshotAt: 0, bytesReceived: 0, bytesSent: 0 }; // Готуємо таймстемпи й лічильники мережі.
    let joined = false; // Не запускаємо input до підтвердження join.
    const timeout = setTimeout(() => reject(new Error(name + ' did not join within five seconds')), 5000); // Обмежуємо очікування кімнати.
    socket.on('open', () => {
      socket.send(JSON.stringify({ v: 1, type: 'join', room: room.id, name, format: 'binary' })); // Входимо з binary протоколом гри.
    }); // Надсилаємо join після відкриття socket.
    socket.on('message', (data, isBinary) => {
      bot.bytesReceived += rawDataLength(data); // Рахуємо всі байти, отримані клієнтом від сервера.
      if (isBinary) {
        const now = performance.now(); // Запам'ятовуємо час серверного знімка.
        if (bot.lastSnapshotAt > 0) bot.snapshotIntervals.push(now - bot.lastSnapshotAt); // Рахуємо паузу між кадрами.
        bot.lastSnapshotAt = now; // Починаємо відлік до наступного snapshot.
        return; // Бінарний кадр уже містить світ, а не текст join-підтвердження.
      } // Завершуємо вимірювання snapshot.
      let message: unknown; // Не довіряємо JSON до перевірки форми.
      try {
        message = JSON.parse(data.toString()); // Розбираємо службове текстове повідомлення.
      } catch {
        return; // Ігноруємо інші або пошкоджені текстові кадри.
      } // Завершуємо JSON parse.
      if (!isRecord(message) || message.type !== 'joined_success' || joined) return; // Чекаємо тільки перше підтвердження входу.
      joined = true; // Фіксуємо, що сервер додав клієнта в кімнату.
      clearTimeout(timeout); // Прибираємо дедлайн успішного join.
      resolve(bot); // Повертаємо готового headless-гравця.
    }); // Завершуємо обробку серверних кадрів.
    socket.once('error', (error) => {
      clearTimeout(timeout); // Не залишаємо таймер після помилки мережі.
      if (!joined) reject(error); // Відхиляємо тільки помилку до підтвердження join.
    }); // Завершуємо обробку помилки з'єднання.
    socket.once('close', (code) => {
      clearTimeout(timeout); // Очищаємо таймер після закриття сокета.
      if (!joined) reject(new Error(name + ' was closed before join: ' + code)); // Показуємо причину відмови сервера.
    }); // Завершуємо обробку закриття.
  }); // Повертаємо очікування готового клієнта.
} // Завершуємо підключення бота.

// Надсилаємо команди з частотою 30 Гц і тим самим семибайтовим форматом input.
function startBotInputs(bots: readonly Bot[]): () => void {
  const interval = 1000 / 30; // Частота команд збігається з кроком серверної симуляції.
  let nextInputAt = performance.now() + interval; // Плануємо першу команду на наступний крок.
  let sequence = 0; // Кожен клієнт отримає послідовний номер input.
  let stopped = false; // Зупинка очищає рекурсивний timeout.
  let timer: ReturnType<typeof setTimeout> | null = null; // Зберігаємо єдиний запланований callback.

  // Плануємо наступний input за цільовим часом.
  function sendNext(): void {
    if (stopped) return; // Не надсилаємо дані після завершення вимірювання.
    const now = performance.now(); // Читаємо поточний монотонний час.
    while (nextInputAt <= now) {
      sequence = (sequence + 1) >>> 0; // Переповнення відповідає uint32 послідовності протоколу.
      const turn = sequence % 3 === 0 ? -1 : sequence % 3 === 1 ? 0 : 1; // Боти повертатимуть ліворуч, прямо й праворуч.
      const input: InputCommand = { seq: asSeq(sequence), gas: true, turn, shoot: sequence % 10 === 0 }; // Команда має ті самі поля, що й клавіатура гравця.
      const frame = serializeInput(input); // Кодуємо packet спільним DataView-модулем.
      for (const bot of bots)
        if (bot.socket.readyState === WebSocket.OPEN) {
          bot.socket.send(frame); // Надсилаємо команду кожному активному гравцю.
          bot.bytesSent += frame.byteLength; // Рахуємо байти input, що пішли від клієнта до сервера.
        }

      // Читаємо процесові метрики з Node сервера, а не з клієнта навантаження.

      nextInputAt += interval; // Переходимо до часу наступного кроку.
    } // Надолужуємо пропущений таймер без setInterval.
    timer = setTimeout(sendNext, Math.max(0, nextInputAt - performance.now())); // Плануємо одне наступне спрацювання.
  } // Завершуємо відправлення input.

  sendNext(); // Починаємо потік ботів.
  return () => {
    stopped = true; // Забороняємо нові input після виміру.
    if (timer) clearTimeout(timer); // Скасовуємо вже запланований крок.
  }; // Повертаємо команду зупинки.
} // Завершуємо фабрику потоку input.

// Виконуємо один сценарій із заданою кількістю одночасних клієнтів.
// Читаємо процесові метрики з Node сервера, а не з клієнта навантаження.
async function readServerStats(): Promise<ServerRuntimeStats> {
  const response = await fetch(new URL('/api/stats', serverUrl)); // Запитуємо метрики окремого серверного процесу.
  if (!response.ok) throw new Error('Stats endpoint returned HTTP ' + response.status); // Не підміняємо відсутні дані нулями.
  const value: unknown = await response.json(); // Перевіряємо JSON перед читанням чисел.
  if (
    !isRecord(value) ||
    typeof value.rssBytes !== 'number' ||
    typeof value.eventLoopActiveMs !== 'number' ||
    typeof value.eventLoopIdleMs !== 'number'
  ) {
    throw new Error('Stats endpoint returned invalid server metrics'); // Зупиняємо звіт, якщо сервер не віддав вимірювані поля.
  }
  return {
    rssBytes: value.rssBytes,
    eventLoopActiveMs: value.eventLoopActiveMs,
    eventLoopIdleMs: value.eventLoopIdleMs,
  }; // Повертаємо тільки перевірені числові метрики.
}

async function runScenario(clientCount: number): Promise<LoadResult> {
  const firstRoom = await createRoom('B' + clientCount + '-0-' + Date.now()); // Створюємо першу ізольовану кімнату виміру.
  console.log('Кімната ботів для лобі: ' + firstRoom.name); // Дозволяємо відкрити ту саму кімнату у браузері під час запису профайлера.
  const rooms = [firstRoom]; // Зберігаємо кімнати для рівномірного розподілу пілотів.
  const roomCount = Math.ceil(clientCount / firstRoom.maxPlayers); // Розраховуємо кількість кімнат з урахуванням ліміту сервера.
  for (let index = 1; index < roomCount; index += 1)
    rooms.push(await createRoom('B' + clientCount + '-' + index + '-' + Date.now())); // Створюємо решту кімнат.
  const bots = await Promise.all(
    Array.from({ length: clientCount }, (_, index) => {
      const room = rooms[Math.floor(index / firstRoom.maxPlayers)]; // Кожен піднабір входить у свою кімнату.
      if (!room) throw new Error('Load-test room allocation failed'); // Перевіряємо, що сервер віддав достатню кількість.
      return connectBot(room, 'B' + clientCount + 'P' + index); // Відкриваємо клієнта без браузерного процесу.
    }),
  ); // Чекаємо, поки сервер підтвердить кожного бота.
  const stopInputs = startBotInputs(bots); // Усі боти надсилають звичайний input.
  const uploadBytesBefore = bots.reduce((total, bot) => total + bot.bytesSent, 0); // Відкидаємо байти підключення до початку виміру.
  const downloadBytesBefore = bots.reduce((total, bot) => total + bot.bytesReceived, 0); // Відкидаємо перші snapshot до початку виміру.
  const startedAt = performance.now(); // Вимірюємо фактичний інтервал, а не лише задану паузу.
  const eventLoopStart = await readServerStats(); // Знімаємо початкові метрики саме серверного процесу.
  const rssStart = eventLoopStart.rssBytes; // Зберігаємо RSS сервера до навантаження.
  let rssPeak = rssStart; // Зберігаємо найбільший RSS сервера під час тесту.
  let lastServerStats = eventLoopStart; // Пам'ятаємо останні показники event loop.
  let pendingStats: Promise<void> | null = null; // Не допускаємо накладання HTTP-запитів метрик.
  const rssSampler = setInterval(() => {
    if (pendingStats) return; // Попередній запит ще виконується.
    pendingStats = readServerStats()
      .then((stats) => {
        lastServerStats = stats; // Оновлюємо останній вимір сервера.
        rssPeak = Math.max(rssPeak, stats.rssBytes); // Зберігаємо максимум RSS між опитуваннями.
      })
      .finally(() => {
        pendingStats = null; // Дозволяємо наступний замір.
      });
  }, 250);
  try {
    await new Promise<void>((resolve) => setTimeout(resolve, durationMs)); // Залишаємо матч активним на час виміру.
    const elapsedSeconds = (performance.now() - startedAt) / 1000; // Фіксуємо справжній час між початком і кінцем трафіку.
    clearInterval(rssSampler); // Припиняємо короткий моніторинг пам'яті після навантаження.
    await pendingStats; // Дочікуємося останнього запиту серверних метрик.
    lastServerStats = await readServerStats(); // Беремо кінцеві метрики сервера після навантаження.
    rssPeak = Math.max(rssPeak, lastServerStats.rssBytes); // Враховуємо кінцеве значення RSS.
    const healthResponse = await fetch(new URL('/health', serverUrl)); // Читаємо час кроку безпосередньо з Node-сервера.
    if (!healthResponse.ok) throw new Error('Health endpoint returned HTTP ' + healthResponse.status); // Не продовжуємо без серверних метрик.
    const health: unknown = await healthResponse.json(); // Вважаємо JSON-відповідь недовіреною.
    if (!isRecord(health) || !Array.isArray(health.stepDurationsMs))
      throw new Error('Health response has no stepDurationsMs'); // Перевіряємо, що сервер надав виміри.
    const durations = health.stepDurationsMs.filter(
      (value): value is number => typeof value === 'number' && Number.isFinite(value),
    ); // Вилучаємо лише скінченні числа.
    const snapshotGaps = bots.flatMap((bot) => bot.snapshotIntervals); // Об'єднуємо проміжки між кадрами всіх клієнтів.
    const uploadBytes = bots.reduce((total, bot) => total + bot.bytesSent, 0) - uploadBytesBefore; // Рахуємо input, надісланий протягом заміру.
    const downloadBytes = bots.reduce((total, bot) => total + bot.bytesReceived, 0) - downloadBytesBefore; // Рахуємо відповіді сервера протягом заміру.
    const activeMs = Math.max(0, lastServerStats.eventLoopActiveMs - eventLoopStart.eventLoopActiveMs); // Визначаємо зайнятий час циклу лише в межах сценарію.
    const idleMs = Math.max(0, lastServerStats.eventLoopIdleMs - eventLoopStart.eventLoopIdleMs); // Визначаємо вільний час циклу лише в межах сценарію.
    return {
      clients: clientCount,
      durationMs,
      tickP50Ms: percentile(durations, 0.5),
      tickP95Ms: percentile(durations, 0.95),
      tickP99Ms: percentile(durations, 0.99),
      tickMaxMs: durations.reduce((maximum, duration) => Math.max(maximum, duration), 0), // Обчислюємо максимум без розгортання всіх семплів як аргументів.
      ticksOver33Ms: durations.reduce((count, duration) => count + Number(duration > 33), 0), // Рахуємо кожен крок понад бюджет, навіть якщо p99 нижче порога.
      snapshotGapP95Ms: percentile(snapshotGaps, 0.95),
      eventLoopUtilization: Number((activeMs / Math.max(1, activeMs + idleMs)).toFixed(4)),
      rssStartMiB: Number((rssStart / 1_048_576).toFixed(1)),
      rssEndMiB: Number((lastServerStats.rssBytes / 1_048_576).toFixed(1)),
      rssPeakMiB: Number((rssPeak / 1_048_576).toFixed(1)),
      uploadBytesPerSecond: Math.round(uploadBytes / elapsedSeconds),
      downloadBytesPerSecond: Math.round(downloadBytes / elapsedSeconds),
      totalBytesPerSecond: Math.round((uploadBytes + downloadBytes) / elapsedSeconds),
    }; // Повертаємо виміряні серверні кроки та проміжки кадрів.
  } finally {
    clearInterval(rssSampler); // Прибираємо sampler і при помилці вимірювання.
    stopInputs(); // Зупиняємо генератор після виміру.
    await Promise.all(
      bots.map(
        (bot) =>
          new Promise<void>((resolve) => {
            if (bot.socket.readyState === WebSocket.CLOSED) return resolve(); // Уже закритий клієнт не потребує очікування.
            bot.socket.once('close', () => resolve()); // Дочікуємося виходу з кімнати.
            bot.socket.close(); // Від'єднуємося штатним WebSocket close.
          }),
      ),
    ); // Звільняємо кімнати перед наступним числом ботів.
  } // Завжди закриваємо усі клієнтські сокети.
} // Завершуємо сценарій навантаження.

// Створюємо простий SVG-графік p95 кроку та межі 33 мс.
function makeLoadChart(results: readonly LoadResult[]): string {
  const width = 760; // Ширина зображення для README.
  const height = 360; // Висота зображення для README.
  const left = 72; // Лишаємо місце під підпис вертикальної осі.
  const top = 24; // Лишаємо простір над лініями графіка.
  const plotWidth = 650; // Ширина області даних.
  const plotHeight = 270; // Висота області даних.
  const maxValue = Math.max(40, ...results.map((result) => result.tickMaxMs * 1.1)); // Вісь адаптується до найбільшого виміру.
  const x = (index: number) => left + (results.length <= 1 ? 0 : (index / (results.length - 1)) * plotWidth); // Перетворюємо індекс на координату X.
  const y = (value: number) => top + plotHeight - (value / maxValue) * plotHeight; // Перетворюємо мілісекунди на координату Y.
  const p95 = results.map((result, index) => x(index) + ',' + y(result.tickP95Ms)).join(' '); // Складаємо лінію p95.
  const p99 = results.map((result, index) => x(index) + ',' + y(result.tickP99Ms)).join(' '); // Складаємо лінію p99.
  const thresholdY = y(33); // Позначаємо межу 33 мс для серверного кроку.
  const labels = results
    .map(
      (result, index) =>
        '<text x="' +
        x(index) +
        '" y="' +
        (top + plotHeight + 24) +
        '" text-anchor="middle">' +
        result.clients +
        ' клієнтів</text>',
    )
    .join(''); // Підписуємо число ботів.
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" width="' +
    width +
    '" height="' +
    height +
    '" viewBox="0 0 ' +
    width +
    ' ' +
    height +
    '"><rect width="100%" height="100%" fill="#0b0c10"/><text x="20" y="20" fill="#fff" font-family="sans-serif">Час кроку сервера за кількістю клієнтів</text><line x1="' +
    left +
    '" y1="' +
    thresholdY +
    '" x2="' +
    (left + plotWidth) +
    '" y2="' +
    thresholdY +
    '" stroke="#ff8c42" stroke-dasharray="6 5"/><text x="' +
    (left + plotWidth - 4) +
    '" y="' +
    (thresholdY - 5) +
    '" text-anchor="end" fill="#ff8c42" font-family="sans-serif">33 мс</text><polyline points="' +
    p95 +
    '" fill="none" stroke="#66fcf1" stroke-width="3"/><polyline points="' +
    p99 +
    '" fill="none" stroke="#b98cff" stroke-width="2"/><text x="20" y="' +
    (top + 15) +
    '" fill="#66fcf1" font-family="sans-serif">p95</text><text x="20" y="' +
    (top + 35) +
    '" fill="#b98cff" font-family="sans-serif">p99</text>' +
    labels +
    '</svg>'
  ); // Повертаємо автономний графік без зовнішньої бібліотеки.
} // Завершуємо побудову SVG.

// Проганяємо всі рівні навантаження, друкуємо метрики та зберігаємо артефакти.
const results: LoadResult[] = []; // Збираємо лише фактично виміряні сценарії.
for (const clientCount of clientCounts) {
  console.log('Підключаю ' + clientCount + ' клієнтів на ' + durationMs + ' мс…'); // Попереджаємо, що сценарій навантажує сервер.
  results.push(await runScenario(clientCount)); // Виконуємо один рівень і чекаємо його завершення.
} // Завершуємо всі чотири рівні.

const resultJson = JSON.stringify(results, null, 2); // Зберігаємо повні процентилі та проміжки між знімками.
const resultPrefix = requestedClientCount === null ? 'load-results' : 'load-results-' + requestedClientCount; // Окремий рівень не перезаписує повний графік навантаження.
await writeFile(new URL('./' + resultPrefix + '.json', import.meta.url), resultJson + '\n', 'utf8'); // Створюємо JSON-артефакт цього запуску.
await writeFile(new URL('./' + resultPrefix + '.svg', import.meta.url), makeLoadChart(results), 'utf8'); // Створюємо графік для README.
console.log(resultJson); // Друкуємо ті самі дані в термінал.
console.log('Графік: server/bench/' + resultPrefix + '.svg'); // Показуємо шлях до створеного зображення.
const firstSlow = results.find((result) => result.ticksOver33Ms > 0); // Знаходимо перший рівень хоча б з одним кроком довшим за 33 мс.
console.log(
  firstSlow
    ? 'Окремі кроки довші за 33 мс вперше з’явилися при ' +
        firstSlow.clients +
        ' клієнтах (' +
        firstSlow.ticksOver33Ms +
        ' кроків).'
    : 'Жоден виміряний крок не перевищив 33 мс у перевірених сценаріях.',
); // Пояснюємо поріг за фактичними кроками, не лише за p99.
