import { fillBotInputs } from './bot-input-work.js'; // Main thread використовує точно такий самий генератор input.

interface WorkerReply {
  readonly buffer: ArrayBuffer;
  readonly workMs: number;
}

interface BenchmarkResult {
  readonly where: string;
  readonly workMs: number;
  readonly wallMs: number;
  readonly timerDelayMs: number;
  readonly bytes: number;
}

const output = document.getElementById('result'); // Показуємо фактичні числа без таблиць.
if (!(output instanceof HTMLElement)) throw new Error('Missing #result output element'); // Відхиляємо неправильну сторінку профайлера.
const runButton = document.getElementById('run'); // Кнопка запускає контрольований експеримент.
if (!(runButton instanceof HTMLButtonElement)) throw new Error('Missing #run button'); // Не починаємо вимір без елемента керування.
const botCount = 8; // Створюємо таку саму кількість ботів, як у вимозі лабораторної.
const ticks = 60_000; // Перевіряємо серію input достатньо довгу для видимого часу обчислень.

// Обчислюємо серію на головному потоці й вимірюємо, наскільки затримався таймер інтерфейсу.
async function runOnMainThread(): Promise<BenchmarkResult> {
  const timerStartedAt = performance.now(); // Таймер запам'ятає, коли головний потік знову зможе обробляти задачі.
  let timerDelayMs = 0; // Зберігаємо фактичне очікування таймера.
  const timer = new Promise<void>((resolve) =>
    setTimeout(() => {
      timerDelayMs = performance.now() - timerStartedAt; // Фіксуємо затримку після повернення керування браузеру.
      resolve(); // Дозволяємо повернути повний результат виміру.
    }, 0),
  ); // Ставимо macrotask перед синхронною роботою.
  const startedAt = performance.now(); // Відміряємо лише обчислення буфера.
  const buffer = new Uint8Array(botCount * ticks * 3); // Працюємо з одним сталим буфером, як і Worker.
  fillBotInputs(buffer, botCount, ticks); // Генеруємо команди на головному потоці.
  const workMs = performance.now() - startedAt; // Зупиняємо час корисної роботи.
  await timer; // Чекаємо, поки браузер виконає відкладений таймер.
  return { where: 'main thread', workMs, wallMs: workMs, timerDelayMs, bytes: buffer.byteLength }; // Повертаємо порівнювані метрики.
} // Завершуємо main-thread вимір.

// Обчислюємо таку саму серію у Web Worker та вимірюємо чутливість main thread.
async function runInWorker(): Promise<BenchmarkResult> {
  const worker = new Worker(new URL('./bot-input.worker.ts', import.meta.url), { type: 'module' }); // Vite збирає окремий модуль Worker.
  const timerStartedAt = performance.now(); // Починаємо контрольний таймер інтерфейсу.
  let timerDelayMs = 0; // Зберігаємо затримку головного потоку під час Worker обчислень.
  const timer = new Promise<void>((resolve) =>
    setTimeout(() => {
      timerDelayMs = performance.now() - timerStartedAt; // Вимірюємо, коли main thread виконав свою задачу.
      resolve(); // Розблоковуємо формування результату.
    }, 0),
  ); // Плануємо задачу до передачі роботи Worker.
  const startedAt = performance.now(); // Враховуємо запуск, обчислення та повернення буфера.
  const reply = await new Promise<WorkerReply>((resolve, reject) => {
    worker.addEventListener('message', (event: MessageEvent<WorkerReply>) => resolve(event.data), { once: true }); // Чекаємо один валідний результат.
    worker.addEventListener('error', (event) => reject(new Error(event.message)), { once: true }); // Не приховуємо помилки Worker.
    worker.postMessage({ botCount, ticks }); // Відправляємо однакові параметри обчислення.
  }); // Завершуємо обмін із worker.
  const wallMs = performance.now() - startedAt; // Враховуємо повний час відправлення та відповіді.
  await timer; // Дочікуємося затримки main thread.
  worker.terminate(); // Звільняємо ресурси окремого потоку після одного прогону.
  return { where: 'Web Worker', workMs: reply.workMs, wallMs, timerDelayMs, bytes: reply.buffer.byteLength }; // Повертаємо роботу і вплив на інтерфейс.
} // Завершуємо Worker вимір.

// Запускаємо два проходи послідовно, щоб їхні буфери не навантажували пам'ять одночасно.
runButton.addEventListener('click', async () => {
  runButton.disabled = true; // Не дозволяємо подвійний запуск із двома великими буферами.
  output.textContent = 'Вимірюю…'; // Показуємо, що браузер виконує контрольовану роботу.
  try {
    const main = await runOnMainThread(); // Спершу вимірюємо базовий головний потік.
    const worker = await runInWorker(); // Потім вимірюємо той самий код у Worker.
    const mainImproved = worker.timerDelayMs < main.timerDelayMs; // Залишати Worker у грі має сенс, якщо main thread менше затримався.
    const result = { main, worker, mainThreadMoreResponsive: mainImproved }; // Виводимо всі виміряні числа для звіту.
    output.textContent = JSON.stringify(result, null, 2); // Відображаємо результат для копіювання в README.
    console.info('[Lab 7 worker experiment]', JSON.stringify(result)); // Дублюємо звіт у консолі браузера.
  } catch (error: unknown) {
    output.textContent = error instanceof Error ? error.message : 'Worker benchmark failed'; // Показуємо причину без падіння сторінки.
  } finally {
    runButton.disabled = false; // Дозволяємо повторити вимір.
  } // Завершуємо кнопку після будь-якого результату.
}); // Завершуємо запуск Worker експерименту.
