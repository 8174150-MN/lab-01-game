// Записуємо тривалість кадрів у сталий буфер, не створюючи масив на кожному rAF.
const profileSearch = typeof globalThis.location === 'undefined' ? '' : globalThis.location.search; // У Node.js тестах немає адреси браузера.
const sectionsEnabled = new URLSearchParams(profileSearch).get('lab7-profile-detail') === '1'; // Детальні User Timing мітки мають окремий перемикач.

// Починаємо короткий User Timing відрізок у вибраному методі.
export function markProfileStart(section: string): void {
  if (sectionsEnabled) performance.mark('lab7:' + section + ':start'); // У звичайній грі не створюємо performance entries.
} // Завершуємо початок User Timing.

// Закриваємо відрізок і лишаємо вимір у Chrome Performance timeline.
export function markProfileEnd(section: string): void {
  if (!sectionsEnabled) return; // Не додаємо накладних витрат поза режимом профілю.
  const start = 'lab7:' + section + ':start'; // Відновлюємо мітку початку за назвою підсистеми.
  const end = 'lab7:' + section + ':end'; // Кожна підсистема має окрему мітку завершення.
  performance.mark(end); // Фіксуємо завершення вимірюваної функції.
  performance.measure('lab7:' + section, start, end); // DevTools показує відрізок у User Timing track.
  performance.clearMarks(start); // Не накопичуємо мітки між кадрами.
  performance.clearMarks(end); // Видаляємо службову мітку завершення після запису measure.
} // Завершуємо короткий User Timing відрізок.

export function startPerformanceProbe(durationMs = 30_000): () => void {
  const frameIntervals = new Float32Array(10_000); // Містить до десяти тисяч послідовних інтервалів кадру.
  let frameCount = 0; // Кількість дійсних значень у циклічному буфері.
  let writeIndex = 0; // Наступна комірка для запису часу кадру.
  let previousFrameAt: number | null = null; // Час попереднього callback requestAnimationFrame.
  let startedAt = performance.now(); // Стартуємо тридцятисекундне вікно профілювання.
  let animationFrame = 0; // Зберігаємо ID callback для ручної зупинки.
  let stopped = false; // Не дозволяємо повторно завершити вже зупинений збір.
  let gcCount = 0; // Рахуємо доступні браузеру події збирання сміття.
  let gcDurationMs = 0; // Сумуємо тривалість пауз, повідомлених PerformanceObserver.
  let gcSupported =
    typeof PerformanceObserver !== 'undefined' && PerformanceObserver.supportedEntryTypes.includes('gc'); // Перевіряємо реальну підтримку типу GC до підписки.
  let observer: PerformanceObserver | null = null; // Зберігаємо observer лише під час цього локального виміру.

  // Записуємо тільки фактичні GC події, якщо браузер підтримує їхній тип.
  if (gcSupported) {
    try {
      observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.entryType !== 'gc') continue; // Ігноруємо інші записи Performance API.
          gcCount += 1; // Додаємо одну спостережену паузу GC.
          gcDurationMs += entry.duration; // Додаємо виміряну тривалість цієї паузи.
        } // Завершуємо обхід подій збирання сміття.
      }); // Реєструємо невеликий обробник без DOM змін.
      observer.observe({ entryTypes: ['gc'] }); // Підписуємося лише після перевірки supportedEntryTypes.
    } catch {
      observer = null; // Продовжуємо збір кадрів, навіть якщо GC observer не запустився.
      gcSupported = false; // Позначаємо фактичну неможливість спостерігати GC.
    } // Завершуємо підключення необов'язкової GC діагностики.
  } // Не видаємо мовчазне прийняття невідомого entryType за підтримку GC.

  // Завершуємо вимір, сортуємо копію буфера один раз і друкуємо реальні числа.
  function finish(): void {
    if (stopped) return; // Повторна зупинка не друкує другий результат.
    stopped = true; // Припиняємо наступні кадри цього профілю.
    cancelAnimationFrame(animationFrame); // Скасовуємо запланований callback збору.
    observer?.disconnect(); // Більше не зберігаємо події GC після виміру.
    const samples = Array.from(frameIntervals.subarray(0, frameCount)).sort((a, b) => a - b); // Копіюємо й сортуємо лише після завершення запису.
    const percentile = (fraction: number): number => {
      const index = Math.min(samples.length - 1, Math.ceil(samples.length * fraction) - 1); // Обираємо найближчий ранг процентиля.
      return samples.length === 0 ? 0 : Number((samples[index] ?? 0).toFixed(2)); // Повертаємо мілісекунди з двома знаками.
    }; // Завершуємо розрахунок одного процентиля.
    console.info(
      '[Lab 7 profile]',
      JSON.stringify({
        durationSeconds: Number(((performance.now() - startedAt) / 1000).toFixed(1)),
        frames: frameCount,
        frameMs: { p50: percentile(0.5), p95: percentile(0.95), p99: percentile(0.99) },
        gc: { supported: gcSupported, pauses: gcCount, totalPauseMs: Number(gcDurationMs.toFixed(2)) },
      }),
    ); // Виводимо фактичний результат без таблиць і бібліотек.
  } // Завершуємо формування звіту профайлера.

  // Заміряємо проміжок між двома кадрами, не змінюючи саму симуляцію гри.
  function recordFrame(now: number): void {
    if (stopped) return; // Callback після ручної зупинки нічого не записує.
    if (previousFrameAt !== null) {
      frameIntervals[writeIndex] = now - previousFrameAt; // Записуємо мілісекунди у фіксований Float32Array.
      writeIndex = (writeIndex + 1) % frameIntervals.length; // Переходимо до наступної комірки кільцевого буфера.
      frameCount = Math.min(frameCount + 1, frameIntervals.length); // Не дозволяємо обліку перевищити місткість.
    } // Перший callback лише задає початковий час.
    previousFrameAt = now; // Цей callback стає початком наступного інтервалу.
    if (now - startedAt >= durationMs) {
      finish(); // Автоматично друкуємо звіт після заданої тривалості.
      return; // Не плануємо ще один кадр після завершення.
    } // Завершуємо вікно виміру.
    animationFrame = requestAnimationFrame(recordFrame); // Продовжуємо збір на наступному кадрі.
  } // Завершуємо один callback профайлера.

  animationFrame = requestAnimationFrame((now) => {
    startedAt = now; // Відраховуємо рівно 30 секунд від першого кадру проби.
    recordFrame(now); // Починаємо запис інтервалів.
  }); // Запускаємо паралельний пасивний монітор кадрів.
  return finish; // Дозволяємо завершити профіль раніше, коли гравець виходить.
} // Завершуємо запуск вимірювача.
