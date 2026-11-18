// Створюємо фіксований цикл симуляції та незалежний від нього рендер.
export interface LoopStats {
  stepsPerSecond: number;
  framesPerSecond: number;
  frameTimeMs: number;
}
interface LoopOptions {
  readonly step?: number;
  readonly simulate: (dt: number) => void;
  readonly render: (alpha: number) => void;
  readonly onStats?: (stats: LoopStats) => void;
  readonly requestFrame?: (callback: FrameRequestCallback) => number;
  readonly cancelFrame?: (handle: number) => void;
}

export function createLoop({
  step = 1 / 60,
  simulate,
  render,
  onStats = () => {},
  requestFrame = requestAnimationFrame,
  cancelFrame = cancelAnimationFrame,
}: LoopOptions): { start(): void; stop(): void; readonly stats: LoopStats } {
  let accumulator = 0; // Зберігаємо час, який ще не витрачений на повний крок фізики.
  let previousTime: number | null = null; // Запам'ятовуємо час попереднього кадру в мілісекундах.
  let statsStart: number | null = null; // Запам'ятовуємо початок поточного інтервалу статистики.
  let steps = 0; // Рахуємо кроки фізики в цьому інтервалі.
  let frames = 0; // Рахуємо кадри рендеру в цьому інтервалі.
  let frameHandle: number | null = null; // Зберігаємо ID rAF, щоб зупинити цикл.
  let running = false; // Не дозволяємо випадково запустити два паралельні цикли.
  const stats: LoopStats = { stepsPerSecond: 0, framesPerSecond: 0, frameTimeMs: 0 }; // Публічні метрики останнього інтервалу.

  // Обробляємо один кадр, використовуючи кількість часу з rAF.
  function frame(now: number): void {
    if (!running) return; // Після stop нових кадрів більше не обробляємо.
    const elapsed = previousTime === null ? 0 : Math.max(0, (now - previousTime) / 1000); // Переводимо інтервал кадру в секунди.
    previousTime = now; // Запам'ятовуємо час цього кадру для наступного.
    stats.frameTimeMs = elapsed * 1000; // Зберігаємо справжній час кадру до обмеження симуляції.
    accumulator += Math.min(elapsed, 0.25); // Обмежуємо великий пропуск після згортання вкладки.
    while (accumulator >= step) {
      // Вирівнюємо фізику фіксованими кроками.
      simulate(step); // Викликаємо гру рівно з однаковим dt на кожному кроці.
      accumulator -= step; // Віднімаємо від акумулятора вже прорахований час.
      steps += 1; // Рахуємо симуляційний крок.
    } // Завершуємо catch-up цикл.
    render(accumulator / step); // Передаємо alpha для інтерполяції між двома станами.
    frames += 1; // Рахуємо один намальований кадр.
    if (statsStart === null) statsStart = now; // Починаємо інтервал метрик на першому кадрі.
    const statsElapsed = now - statsStart; // Вимірюємо точну тривалість інтервалу статистики.
    if (statsElapsed >= 1000) {
      // Оновлюємо HUD приблизно раз на секунду.
      stats.stepsPerSecond = Math.round((steps * 1000) / statsElapsed); // Нормалізуємо кроки до однієї секунди.
      stats.framesPerSecond = Math.round((frames * 1000) / statsElapsed); // Нормалізуємо кадри до однієї секунди.
      onStats({ ...stats }); // Віддаємо копію статистики зовнішньому HUD.
      steps = 0; // Починаємо новий відлік фізичних кроків.
      frames = 0; // Починаємо новий відлік кадрів рендеру.
      statsStart = now; // Пересуваємо початок інтервалу.
    } // Завершуємо оновлення HUD.
    frameHandle = requestFrame(frame); // Плануємо наступний кадр через браузерний rAF.
  } // Завершуємо обробник кадру.

  // Запускаємо цикл з чистим таймером і порожнім акумулятором.
  function start() {
    if (running) return; // Повторний виклик не створює другий цикл.
    running = true; // Позначаємо цикл активним.
    accumulator = 0; // Не переносимо борг між окремими запусками.
    previousTime = null; // Перший кадр не додає штучний час до симуляції.
    statsStart = null; // Починаємо вимірювання на першому кадрі.
    steps = 0; // Скидаємо лічильник кроків.
    frames = 0; // Скидаємо лічильник кадрів.
    frameHandle = requestFrame(frame); // Просимо браузер викликати перший кадр.
  } // Завершуємо запуск.

  // Зупиняємо цикл і скасовуємо вже запланований кадр.
  function stop() {
    running = false; // Наступний callback одразу вийде на початку.
    if (frameHandle !== null) cancelFrame(frameHandle); // Скасовуємо запланований кадр.
    frameHandle = null; // Прибираємо застарілий ID кадру.
  } // Завершуємо зупинку.

  // Повертаємо команди керування та доступ до останніх метрик.
  return { start, stop, stats }; // Викликач може відобразити або перевірити метрики.
} // Завершуємо фабрику циклу.
