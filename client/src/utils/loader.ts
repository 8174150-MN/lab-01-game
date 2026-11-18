// 1. HttpError: власний вид помилки для відповідей сервера
// Проблема: функція fetch вважає відповідь 404 "успішною", бо сервер
// таки відповів (хоч і "файлу немає"). Помилкою fetch вважає лише
// ситуацію, коли відповіді взагалі не було (немає інтернету).
// Тому 404 перетворимо на помилку самі.
// export: дозволяє підключити цей клас в інших файлах.
// class HttpError extends Error: створюємо новий тип помилки на основі
// стандартного Error, але з додатковим полем status.
export class HttpError extends Error {
  readonly status: number;
  // constructor запускається, коли пишемо new HttpError(...)
  constructor(status: number, url: string) {
    // super(...) викликає конструктор стандартного Error
    // і задає текст помилки. Рядок у зворотних лапках `...` дозволяє
    // вставляти змінні через ${...}.
    super(`HTTP ${status} для ${url}`);
    // name: назва типу помилки, її видно в консолі.
    this.name = 'HttpError';
    // status: код відповіді (404, 500...). Пізніше за ним ми вирішимо,
    // чи повторювати запит: 4xx повторювати марно, 5xx можна.
    this.status = status;
  }
}
// 2. fetchJson: завантажує JSON і перевіряє, що все пройшло успішно
// async: функція завжди повертає проміс (обіцянку результату),
// і всередині неї можна писати await.
// Параметри:
//   url          адреса файлу
//   { signal }   другий параметр це об'єкт, з якого ми одразу дістаємо
//                поле signal: сигнал, яким запит можна скасувати
//   = {}         значення за замовчуванням, щоб можна було викликати
//                fetchJson(url) без другого аргумента
export async function fetchJson(url: string, { signal }: { readonly signal?: AbortSignal } = {}): Promise<unknown> {
  // fetch надсилає запит. await каже: "дочекайся відповіді, але не
  // заморожуй браузер". Змінна response отримає відповідь сервера
  // (поки лише заголовки, без вмісту файлу).
  const response = await fetch(url, { signal });
  // response.ok дорівнює true, якщо статус від 200 до 299.
  // Знак ! означає "НЕ". Тобто якщо відповідь неуспішна, то
  // throw зупиняє функцію і кидає нашу помилку.
  if (!response.ok) throw new HttpError(response.status, url);
  // response.json() читає вміст файлу й перетворює текст на об'єкт.
  // Це окремий асинхронний крок (тіло приходить після заголовків).
  // Якщо JSON зламаний, тут виникне помилка SyntaxError. Саме це ми
  // потім покажемо в "галереї збоїв".
  // await перед return не потрібен: async-функція сама дочекається.
  return response.json();
}
// 3. loadJson: коротка обгортка в єдиному стилі loadЩось(url, signal)
// (url, signal) => ...  це стрілкова функція. Без фігурних дужок вона
// одразу повертає результат виразу праворуч від стрілки.
export const loadJson = (url: string, signal?: AbortSignal): Promise<unknown> => fetchJson(url, { signal });
// 4. loadImage: завантажує картинку для малювання на canvas
export async function loadImage(url: string, signal?: AbortSignal): Promise<ImageBitmap> {
  // Завантажуємо файл так само, як картинку.
  const response = await fetch(url, { signal });
  // 404 і 500 стають помилкою.
  if (!response.ok) throw new HttpError(response.status, url);
  // blob це сирі байти файлу
  const blob = await response.blob();
  //Розшифровуемо байти в картинку яку можна малювати на canvas
  return createImageBitmap(blob);
}
// 5. loadAudio: завантажує звук і розшифровує його заздалегідь
// ctx це AudioContext (звуковий рушій браузера). Його створимо в
// audio.js пізніше, а тут ми лише отримуємо його як параметр.
export async function loadAudio(ctx: AudioContext, url: string, signal?: AbortSignal): Promise<AudioBuffer> {
  //Завантажуємо файл
  const response = await fetch(url, { signal });
  // 404 і 500 стають помилкою.
  if (!response.ok) throw new HttpError(response.status, url);
  // arrayBuffer це сирі байти файлу mp3.
  const bytes = await response.arrayBuffer();
  // decodeAudioData перетворює mp3 на AudioBuffer: готовий до
  // відтворення звук у пам'яті. Робимо це на екрані завантаження,
  // щоб перший постріл не гальмував гру.
  return ctx.decodeAudioData(bytes);
}
// 6. sleep: пауза, яку можна скасувати
// Повертає проміс, що виконається через ms мілісекунд.
// Якщо за цей час спрацює signal (abort), пауза одразу переривається.
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  // new Promise((resolve, reject) => ...) створює проміс вручну:
  //   resolve() означає "готово"; reject(помилка) означає "збій".
  return new Promise<void>((resolve, reject) => {
    // Якщо скасування вже сталося, одразу відхиляємо.
    if (signal?.aborted) return reject(signal.reason);
    // Запускаємо таймер: через ms викликаємо onTimer.
    const timerId = setTimeout(onTimer, ms);
    // Таймер дочекався кінця.
    function onTimer() {
      // Знімаємо слухача, він більше не потрібен.
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }
    // Хтось викликав abort(), тож зупиняємо таймер і відхиляємо.
    function onAbort() {
      clearTimeout(timerId);
      reject(signal?.reason);
    }
    // { once: true } означає, що слухач спрацює максимум один раз.
    // signal?. означає "якщо signal існує". Без ? був би збій, коли
    // сигнал не передали.
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
// 7. withRetry: повторює невдалу операцію з паузами
// fn      функція без аргументів, що повертає проміс (наприклад
//         () => loadJson(url)). Її ми викликаємо знову і знову.
// attempts   скільки всього спроб (за замовчуванням 3)
// baseMs     базова пауза в мс (за замовчуванням 300)
// signal     сигнал скасування
// onRetry    необов'язковий "підглядач": викликається перед кожною
//            паузою (потрібен, щоб бачити повтори в консолі)
interface RetryOptions {
  readonly attempts?: number;
  readonly baseMs?: number;
  readonly signal?: AbortSignal;
  readonly onRetry?: (nextAttempt: number, delayMs: number, error: unknown) => void;
}
export async function withRetry<Value>(
  fn: () => Promise<Value>,
  { attempts = 3, baseMs = 300, signal, onRetry }: RetryOptions = {},
): Promise<Value> {
  // Цикл: attempt = 0, 1, 2... до attempts - 1.
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      // Пробуємо виконати. Якщо вдалося, повертаємо результат
      // і виходимо з функції (повтори більше не потрібні).
      return await fn();
    } catch (err) {
      // Якщо гравець сам скасував операцію, повторювати не можна.
      if (signal?.aborted) throw err;
      // 4xx (404, 403...) це наша помилка: запит не зміниться, тож
      // повтор безглуздий. Кидаємо помилку одразу.
      // instanceof перевіряє, що err саме наш HttpError.
      if (err instanceof HttpError && err.status >= 400 && err.status < 500) {
        throw err;
      }
      // Це була остання спроба, здаємось.
      if (attempt === attempts - 1) throw err;
      // Exponential backoff: пауза подвоюється з кожною спробою.
      // 2 ** attempt означає 2 у степені attempt: 1, 2, 4, 8...
      // При baseMs = 300 максимум буде 300, 600, 1200...
      const maxDelay = baseMs * 2 ** attempt;
      // Jitter: випадкова пауза від 0 до maxDelay. Так багато
      // клієнтів не стукатимуть на сервер одночасно.
      const delay = Math.random() * maxDelay;
      // Повідомляємо "підглядача" (якщо він є).
      onRetry?.(attempt + 1, Math.round(delay), err);
      // Чекаємо цю паузу і переходимо до наступної спроби.
      await sleep(delay, signal);
    }
  }
  throw new Error('Retry attempts must be at least one'); // Нульова кількість спроб не має результату.
}
// 8. Допоміжні функції для loadAll

// combineSignals: об'єднує кілька сигналів скасування в один.
// filter(Boolean) викидає порожні значення (null, undefined).
function combineSignals(signals: readonly (AbortSignal | null | undefined)[]): AbortSignal | undefined {
  const list = signals.filter((signal): signal is AbortSignal => signal !== null && signal !== undefined);
  if (list.length === 0) return undefined;
  if (list.length === 1) return list[0];
  // AbortSignal.any спрацює, коли спрацює ХОЧА Б ОДИН із сигналів.
  return AbortSignal.any(list);
}

// buildTasks: перетворює manifest на список завдань.
// timeoutMs: скільки чекати на ОДНУ спробу завантаження файлу (0 = без ліміту).
export interface AssetManifest {
  readonly images?: Readonly<Record<string, string>>;
  readonly sounds?: Readonly<Record<string, string>>;
  readonly json?: Readonly<Record<string, string>>;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function isAssetManifest(value: unknown): value is AssetManifest {
  if (!isRecord(value)) return false;
  return ['images', 'sounds', 'json'].every((group) => {
    const entries = value[group];
    return (
      entries === undefined || (isRecord(entries) && Object.values(entries).every((url) => typeof url === 'string'))
    );
  });
}
type AssetGroup = 'images' | 'sounds' | 'json';
interface AssetTask {
  readonly group: AssetGroup;
  readonly name: string;
  load(): Promise<unknown>;
}
export interface LoadedAssets {
  readonly images: Record<string, ImageBitmap>;
  readonly sounds: Record<string, AudioBuffer>;
  readonly json: Record<string, unknown>;
}
interface LoadOptions {
  readonly audioCtx?: AudioContext;
  readonly onProgress?: (done: number, total: number, name: string) => void;
  readonly signal?: AbortSignal;
  readonly debugDelayMs?: number;
  readonly timeoutMs?: number;
}

function buildTasks(manifest: AssetManifest, { audioCtx, signal, debugDelayMs, timeoutMs }: LoadOptions): AssetTask[] {
  const tasks: AssetTask[] = [];

  // loader це функція, яка приймає сигнал і запускає завантаження.
  const add = (group: AssetGroup, name: string, loader: (signal?: AbortSignal) => Promise<unknown>): void => {
    tasks.push({
      group,
      name,
      load: async () => {
        // Штучна затримка тільки для тестів (параметр ?delay= в адресі).
        if (debugDelayMs) await sleep(debugDelayMs, signal);

        return withRetry(
          // Кожна спроба отримує СВІЙ таймаут. Якщо сервер мовчить довше
          // timeoutMs, fetch завершується помилкою TimeoutError.
          () => loader(combineSignals([signal, timeoutMs ? AbortSignal.timeout(timeoutMs) : null])),
          { signal },
        );
      },
    });
  };

  for (const [name, url] of Object.entries(manifest.images ?? {})) {
    add('images', name, (requestSignal) => loadImage(url, requestSignal));
  }
  for (const [name, url] of Object.entries(manifest.sounds ?? {})) {
    add('sounds', name, (requestSignal) => {
      if (!audioCtx) throw new Error('AudioContext is required for sound assets');
      return loadAudio(audioCtx, url, requestSignal);
    });
  }
  for (const [name, url] of Object.entries(manifest.json ?? {})) {
    add('json', name, (requestSignal) => loadJson(url, requestSignal));
  }

  return tasks;
}

// collect: складає результати в об'єкт assets.images.hero, assets.sounds.shoot...
function collect(tasks: readonly AssetTask[], results: readonly unknown[]): LoadedAssets {
  const assets: LoadedAssets = { images: {}, sounds: {}, json: {} };
  tasks.forEach((task, index) => {
    const value = results[index];
    if (value === undefined) throw new Error('Missing loaded asset: ' + task.name);
    if (task.group === 'images') {
      if (!(value instanceof ImageBitmap)) throw new TypeError('Invalid image asset: ' + task.name);
      assets.images[task.name] = value;
    } else if (task.group === 'sounds') {
      if (!(value instanceof AudioBuffer)) throw new TypeError('Invalid audio asset: ' + task.name);
      assets.sounds[task.name] = value;
    } else {
      assets.json[task.name] = value;
    }
  });
  return assets;
}

// 9. loadAll: усе одночасно через Promise.all + прогрес
export async function loadAll(
  manifest: AssetManifest,
  { audioCtx, onProgress, signal, debugDelayMs = 0, timeoutMs = 0 }: LoadOptions = {},
): Promise<LoadedAssets> {
  const tasks = buildTasks(manifest, { audioCtx, signal, debugDelayMs, timeoutMs });
  const total = tasks.length;
  let done = 0;

  // Запускаємо ВСІ завдання одразу. До кожного додаємо .then,
  // який рахує завершені файли й повідомляє про прогрес.
  const promises = tasks.map((task) =>
    task.load().then((value) => {
      done += 1;
      onProgress?.(done, total, task.name);
      return value;
    }),
  );

  // Promise.all: чекаємо на всі; при першій помилці одразу відхиляється.
  const results = await Promise.all(promises);
  return collect(tasks, results);
}

// 10. loadAllSequential
export async function loadAllSequential(
  manifest: AssetManifest,
  { audioCtx, onProgress, signal, debugDelayMs = 0, timeoutMs = 0 }: LoadOptions = {},
): Promise<LoadedAssets> {
  const tasks = buildTasks(manifest, { audioCtx, signal, debugDelayMs, timeoutMs });
  const results: unknown[] = [];

  for (const task of tasks) {
    results.push(await task.load()); // кожен await чекає попередній файл
    onProgress?.(results.length, tasks.length, task.name);
  }

  return collect(tasks, results);
}
