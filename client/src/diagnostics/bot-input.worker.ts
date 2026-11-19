import { fillBotInputs } from './bot-input-work.js'; // Worker запускає ту саму чисту функцію, що й головний потік.

interface WorkRequest {
  readonly botCount: number;
  readonly ticks: number;
}

interface WorkResponse {
  readonly buffer: ArrayBuffer;
  readonly workMs: number;
}

interface WorkerGlobalScopeLike {
  addEventListener(type: 'message', listener: (event: MessageEvent<WorkRequest>) => void): void;
  postMessage(message: WorkResponse, transfer: Transferable[]): void;
}

const workerScope = self as unknown as WorkerGlobalScopeLike; // Ця entry запускається тільки у Worker, але клієнтський tsconfig описує self як Window.

// Обчислюємо вхідні команди поза головним потоком і передаємо буфер без копії.
workerScope.addEventListener('message', (event) => {
  const startedAt = performance.now(); // Відокремлюємо час корисної роботи від запуску Worker.
  const buffer = new Uint8Array(event.data.botCount * event.data.ticks * 3); // Виділяємо один компактний буфер на всі команди.
  fillBotInputs(buffer, event.data.botCount, event.data.ticks); // Заповнюємо байти тим самим алгоритмом, що й main thread.
  const result: WorkResponse = { buffer: buffer.buffer, workMs: performance.now() - startedAt }; // Повертаємо час і готові дані.
  workerScope.postMessage(result, [buffer.buffer]); // Transferable передає володіння масивом без копіювання мегабайтів.
}); // Завершуємо відповідь Worker.

export {}; // Позначаємо файл як модуль і не створюємо глобальні імена.
