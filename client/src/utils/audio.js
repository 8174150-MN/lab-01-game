// AudioEngine володіє Web Audio API й не імпортується симуляцією.
import { bus } from '../events.js'; // Події гри відокремлюють звук від фізики.

export function createAudioEngine() {
  let context = null; // AudioContext створиться лише після кліку гравця.
  let buffers = {}; // Тут зберігаються буфери, завантажені під час екрана прогресу.

  // Розблоковуємо звук у межах користувацького жесту й повертаємо контекст.
  async function unlock() {
    if (!context) context = new AudioContext(); // Браузер дозволяє створення після кліку.
    if (context.state === 'suspended') await context.resume(); // Поновлюємо контекст, якщо він ще призупинений.
    return context; // Завантажувач використовує цей самий контекст для декодування.
  } // Завершуємо розблокування.

  // Зберігаємо декодовані звуки після Promise.all.
  function setBuffers(loadedBuffers) {
    buffers = loadedBuffers; // Підміна об'єкта не змінює API ігрового коду.
  } // Завершуємо встановлення буферів.

  // Відтворюємо один буфер із заданою гучністю.
  function play(name, volume = 1) {
    if (!context || context.state !== 'running') return; // Не створюємо джерело до розблокування.
    const buffer = buffers[name]; // Шукаємо попередньо декодований звук.
    if (!buffer) return; // Пропускаємо необов'язковий звук, якого немає.
    const source = context.createBufferSource(); // Джерело звуку можна використати лише один раз.
    source.buffer = buffer; // Підставляємо декодовані аудіодані.
    const gain = context.createGain(); // Створюємо регулятор гучності.
    gain.gain.value = volume; // Виставляємо рівень звуку для цієї події.
    source.connect(gain); // Направляємо джерело до регулятора.
    gain.connect(context.destination); // Направляємо звук на вихід пристрою.
    source.start(); // Починаємо відтворення без додаткового таймера.
  } // Завершуємо запуск звуку.

  bus.addEventListener('fired', () => play('shoot', 0.5)); // Постріл відтворює лазер.
  bus.addEventListener('hit', () => play('explosion', 0.3)); // Влучання відтворює тихий звук.
  bus.addEventListener('exploded', () => play('explosion', 0.8)); // Вибух відтворює гучніший звук.

  // Повертаємо контрольовані методи без прямого доступу до приватних змінних.
  return {
    unlock,
    setBuffers,
    get context() {
      return context;
    },
  }; // Екран старту розблоковує звук першим кліком.
} // Завершуємо фабрику звукового рушія.
