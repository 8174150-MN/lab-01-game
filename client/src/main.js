// Імпортуємо замикання клавіатури для керування без глобального стану.
import { createInput } from './input.js'; // Повертає читальні методи для клавіш.
import { createLoop } from './loop.js'; // Відокремлює частоту симуляції від частоти екрана.
import { World } from './world.js'; // Керує сутностями та зіткненнями.
import { Ship, Asteroid } from './entities.js'; // Модель корабля й перешкод не залежить від DOM.
import { withHoming } from './components.js'; // Додає homing поведінкою, а не наслідуванням.
import { loadJson, loadAll } from './utils/loader.js'; // Завантажує manifest ігрових ресурсів.
import { createAudioEngine } from './utils/audio.js'; // Створює звук після жесту гравця.
import { sprites } from './sprites.js'; // Зберігає завантажені спрайти.
import { Lobby } from './lobby.js'; // Керує кімнатами й мережевим опитуванням.
import { createLobbyView } from './ui/lobby.js'; // Окремо малює DOM лобі.
import { createHud } from './ui/hud.js'; // Відображає ім'я, життя, рахунок і метрики.
import { showError } from './ui/errorScreen.js'; // Показує помилку й кнопку повтору.
import { startSession } from './net/session.js'; // Підключає до кімнати WebSocket-клієнта.

// Знаходимо полотно та контекст малювання один раз під час старту модуля.
const canvas = document.getElementById('gameCanvas'); // Canvas показує арену.
const ctx = canvas.getContext('2d'); // Контекст 2D надає команди малювання.
const hudElement = document.getElementById('hud'); // Контейнер статистики та рахунку.
const input = createInput(window); // Замикання слухає клавіатуру в браузерному вікні.
const audio = createAudioEngine(); // Контекст звуку поки що не створюється.
let width = 0; // Ширина полотна в CSS-пікселях.
let height = 0; // Висота полотна в CSS-пікселях.
let world = null; // World буде створений після вимірювання canvas.
let ship = null; // Посилання на поточний корабель гравця.
let lobby = null; // Lobby живе, поки гравець перебуває на екрані кімнат.
let lobbyView = null; // DOM-подання лобі має окремі команди show та hide.
let session = null; // WebSocket-сесія відкривається після вибору кімнати.
let playing = false; // Прапорець вмикає симуляцію після натискання Join.
let loadController = null; // Контролер дозволяє скасувати поточне завантаження.
let respawnTime = 0; // Таймер відродження корабля вимірюється в секундах.
let asteroidTimer = 0; // Таймер періодичного створення перешкод.
let defaultArena = { asteroidCount: 5 }; // Статичний arena.json задає значення за замовчуванням.
const hud = createHud(hudElement); // Підписує HUD на події рахунку, життя й звуку.

// Підганяємо backing store canvas під CSS-розмір і масштаб пристрою.
function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1; // На звичайному екрані DPR дорівнює 1.
  width = window.innerWidth; // Читаємо ширину області браузера.
  height = window.innerHeight; // Читаємо висоту області браузера.
  canvas.width = Math.round(width * dpr); // Збільшуємо bitmap для чіткого рендеру на Retina.
  canvas.height = Math.round(height * dpr); // Збільшуємо bitmap по вертикалі.
  canvas.style.width = width + 'px'; // Зберігаємо CSS-розмір у логічних пікселях.
  canvas.style.height = height + 'px'; // Зберігаємо CSS-висоту.
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0); // Встановлюємо масштаб, не накопичуючи його після resize.
  if (world) {
    world.width = width;
    world.height = height;
  } // Оновлюємо межі арени після зміни вікна.
} // Завершуємо підлаштування canvas.

window.addEventListener('resize', resizeCanvas); // Повторно налаштовуємо bitmap при зміні розміру вікна.
resizeCanvas(); // Налаштовуємо canvas до створення гри.
world = new World(width, height); // Створюємо світ після того, як відомі межі.
ship = new Ship(width / 2, height / 2); // Ставимо перший корабель у центр арени.
world.spawn(ship); // Додаємо гравця до entity store.

// Шукаємо безпечну точку для респауну, подалі від астероїдів.
function findSafeSpawn() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    // Обмежуємо кількість випадкових перевірок.
    const point = { x: Math.random() * width, y: Math.random() * height }; // Випадково обираємо кандидата.
    const safe = [...world.ofKind('asteroid')].every((asteroid) => asteroid.pos.dist(point) > asteroid.radius + 80); // Відкидаємо точки біля перешкод.
    if (safe) return point; // Повертаємо першу безпечну позицію.
  } // Завершуємо обмежений пошук.
  return { x: width / 2, y: height / 2 }; // У переповненій арені використовуємо центр як запасний варіант.
} // Завершуємо пошук точки.

// Оновлюємо стан симуляції одним кроком у 1/60 секунди.
function simulate(dt) {
  if (!playing) return; // Не рухаємо корабель до вибору кімнати або після виходу.
  const commands = {
    left: input.isDown('ArrowLeft'),
    right: input.isDown('ArrowRight'),
    thrust: input.isDown('ArrowUp'),
    firePressed: input.justPressed('Space'),
  }; // Зчитуємо клавіші один раз за крок.
  world.step(dt, commands); // Передаємо чистий стан вводу у світ.
  input.clearJustPressed(); // Одноразові клавіші не повторюються в наступному кроці.
  if (ship.isDead) {
    // Починаємо відлік лише після першої смерті.
    if (respawnTime === 0) respawnTime = 2; // Вимога лабораторної задає дві секунди до респауну.
    respawnTime -= dt; // Відраховуємо фіксований час симуляції.
    if (respawnTime <= 0) {
      const point = findSafeSpawn();
      ship = new Ship(point.x, point.y);
      world.spawn(ship);
      respawnTime = 0;
    } // Створюємо корабель у безпечному місці.
  } // Завершуємо контроль респауну.
  asteroidTimer += dt; // Накопичуємо час до наступної перешкоди.
  if (asteroidTimer >= 2) {
    const asteroid = new Asteroid(Math.random() * width, 0, 16);
    if (Math.random() < 0.2) withHoming(asteroid, ship, 20);
    world.spawn(asteroid);
    asteroidTimer = 0;
  } // Додаємо звичайний або самонавідний астероїд.
} // Завершуємо крок симуляції.

// Малюємо інтерпольований стан світу, щоб корабель був плавним і на 120 Hz.
function render(alpha) {
  world.render(ctx, alpha); // World використовує alpha між попереднім і поточним станом.
} // Завершуємо кадр.

const loop = createLoop({
  step: 1 / 60,
  simulate,
  render,
  onStats: (stats) =>
    hud.setPerf(
      'Кроки/с: ' +
        stats.stepsPerSecond +
        ' | Кадри/с: ' +
        stats.framesPerSecond +
        ' | Кадр: ' +
        stats.frameTimeMs.toFixed(1) +
        ' мс',
    ),
}); // Під'єднуємо фіксований цикл і статистику до HUD.

// Додаємо повідомлення чату без вставки довільного HTML.
function addChatMessage(sender, message) {
  const list = document.getElementById('chatMessages'); // Знаходимо список повідомлень.
  const row = document.createElement('p'); // Створюємо безпечний текстовий рядок.
  row.textContent = sender + ': ' + message; // textContent не інтерпретує текст як HTML.
  list.append(row); // Додаємо повідомлення в кінець чату.
  list.scrollTop = list.scrollHeight; // Прокручуємо список до нового рядка.
} // Завершуємо додавання повідомлення.

// Надсилаємо текст чату через API активної кімнатної сесії.
document.getElementById('chatForm').addEventListener('submit', (event) => {
  event.preventDefault(); // Не перезавантажуємо сторінку через HTML-форму.
  const field = document.getElementById('chatInput'); // Беремо поле введення повідомлення.
  const text = field.value.trim(); // Відкидаємо порожній текст і пробіли по краях.
  if (!text || !session) return; // Не надсилаємо порожні рядки або повідомлення поза кімнатою.
  session.sendChat(text); // Клієнтська сесія поставить повідомлення в чергу сокета.
  field.value = ''; // Очищаємо поле після надсилання.
}); // Завершуємо обробник форми чату.

// Показуємо в HUD список гравців, які вже зайшли в кімнату.
function showRoster(players = []) {
  const roster = document.getElementById('roomRoster'); // Знаходимо місце для учасників кімнати.
  if (roster) roster.textContent = 'У кімнаті: ' + players.map((player) => player.name).join(', '); // Відображаємо лише перевірені текстові імена.
} // Завершуємо оновлення списку.

// Стартуємо локальний матч після натискання Join у лобі.
function joinGame({ room, name, arena }) {
  playing = true; // Дозволяємо симуляції й рендеру початися.
  hud.setName(name); // Показуємо ім'я власного корабля.
  lobbyView.hide(); // Приховуємо список кімнат і скасовуємо його запит.
  session?.leave(); // Закриваємо попередню сесію, якщо вона існувала.
  session = startSession({
    roomId: room.id,
    name,
    onRoster: (message) => showRoster(message.players),
    onChat: (message) => addChatMessage(message.sender, message.text),
    onStatus: (status, data) => {
      if (status === 'joined' && data?.players) showRoster(data.players);
    },
  }); // Приєднуємося до сервера та слухаємо кімнатні події.
  const count = Number(arena?.asteroidCount ?? defaultArena.asteroidCount) || 5; // Поєднуємо кімнату з arena.json або початковою кількістю.
  for (let i = 0; i < count; i += 1) world.spawn(new Asteroid(Math.random() * width, Math.random() * height, 16)); // Створюємо перешкоди матчу.
  document.getElementById('chatBox').hidden = false; // Відкриваємо чат після входу.
  document.getElementById('leaveGameBtn').hidden = false; // Показуємо вихід із кімнати.
  loop.start(); // Починаємо rAF лише після вибору кімнати.
} // Завершуємо запуск матчу.

// Завантажуємо активи й після цього готуємо лобі.
async function boot() {
  loadController = new AbortController(); // Створюємо окреме скасування для цього завантаження.
  const signal = loadController.signal; // Передаємо один сигнал усім мережевим запитам.
  const params = new URLSearchParams(location.search); // Читаємо необов'язкові режими демонстрації з URL.
  const failure = params.get('fail'); // Режим fail дає відтворити сценарії з README.
  const loadingControls = document.getElementById('loadingControls'); // Знаходимо статус і кнопку скасування.
  loadingControls.hidden = false; // Показуємо керування завантаженням.
  try {
    // Перехоплюємо мережеві помилки й показуємо зрозумілий Retry.
    drawLoading(0, 1, 'manifest'); // Відображаємо перший етап прогресу.
    const manifest = await loadJson('/assets/manifest.json', signal); // Завантажуємо єдиний опис усіх файлів.
    if (failure === '404') manifest.images.hero = '/assets/not-found.png'; // Підміняємо спрайт на відсутній для досліду 404.
    if (failure === 'timeout') manifest.json.arena = '/api/demo/slow?delay=3000'; // Підміняємо JSON ресурс локальним повільним маршрутом.
    if (failure === 'json') manifest.json.arena = '/assets/broken-json.txt'; // Підміняємо JSON ресурс пошкодженим текстом.
    const timeoutMs = failure === 'timeout' ? 250 : 5000; // Робимо контрольований короткий timeout лише в демонстрації.
    if (failure === 'abort') setTimeout(() => loadController?.abort(), 150); // Автоматично перериваємо режим демонстрації abort посеред завантаження.
    const loaded = await loadAll(manifest, {
      audioCtx: audio.context,
      signal,
      timeoutMs,
      debugDelayMs: failure === 'abort' ? 1000 : 0,
      onProgress: (done, total, file) => drawLoading(done, total, file),
    }); // Чекаємо всі ресурси й показуємо прогрес для кожного.
    defaultArena = loaded.json.arena ?? defaultArena; // Зберігаємо arena.json як початкові налаштування гри.
    Object.assign(sprites, loaded.images); // Передаємо зображення в модуль рендеру.
    audio.setBuffers(loaded.sounds); // Зберігаємо декодовані аудіобуфери.
    loadingControls.hidden = true; // Ховаємо індикатор після успішного завантаження.
    lobby = new Lobby(); // Створюємо модель лобі без DOM-залежностей.
    lobbyView = createLobbyView(lobby, document.getElementById('lobby')); // Будуємо DOM лобі в окремому модулі.
    lobby.addEventListener('joined', (event) => joinGame(event.detail)); // Зв'язуємо вибір кімнати зі стартом гри.
    lobbyView.show(); // Показуємо лобі й запускаємо перший HTTP-запит.
  } catch (error) {
    // Всі помилки активів ведуть на екран повтору.
    loadController.abort(); // Скасовуємо всі паралельні запити після першої помилки.
    loadingControls.hidden = true; // Прибираємо кнопку скасування після завершення спроби.
    showError(document.getElementById('errorScreen'), describeError(error), () => boot()); // Показуємо повідомлення й запускаємо нову спробу після кліку.
  } // Завершуємо обробку помилок завантаження.
} // Завершуємо boot.

// Малюємо справжній прогрес завантаження на полотні.
function drawLoading(done, total, label) {
  ctx.clearRect(0, 0, width, height); // Стираємо попередній стан екрана.
  ctx.fillStyle = '#0b0c10'; // Встановлюємо фон гри.
  ctx.fillRect(0, 0, width, height); // Заповнюємо всю площу фоном.
  const barWidth = Math.min(420, width * 0.7); // Не даємо смузі вийти за межі малого екрана.
  const x = (width - barWidth) / 2; // Центруємо смугу по горизонталі.
  const y = height / 2; // Розміщуємо смугу посередині.
  ctx.strokeStyle = '#66fcf1'; // Задаємо колір контуру смуги.
  ctx.strokeRect(x, y, barWidth, 22); // Малюємо рамку прогресу.
  ctx.fillStyle = '#4ade80'; // Задаємо колір заповнення.
  ctx.fillRect(x, y, barWidth * (total ? done / total : 0), 22); // Заповнюємо частину відповідно до кількості файлів.
  ctx.fillStyle = '#fff'; // Задаємо колір напису.
  ctx.font = '16px monospace'; // Встановлюємо читабельний шрифт статусу.
  ctx.textAlign = 'center'; // Центруємо текст над смугою.
  ctx.fillText('Завантаження ' + done + '/' + total + ' — ' + label, width / 2, y - 14); // Показуємо назву останнього файлу.
} // Завершуємо малювання прогресу.

// Перетворюємо тип помилки на повідомлення без технічного стеку.
function describeError(error) {
  if (error.name === 'AbortError') return 'Завантаження скасовано. Натисни «Повторити», щоб почати знову.'; // Пояснюємо ручний або тестовий abort.
  if (error.name === 'TimeoutError') return 'Сервер не відповів вчасно. Перевір з’єднання та повтори.'; // Пояснюємо таймаут мережі.
  if (error.name === 'HttpError')
    return 'Не вдалося завантажити файл (HTTP ' + error.status + '). Перевір адресу та повтори.'; // Пояснюємо 4xx/5xx відповідь.
  if (error.name === 'SyntaxError') return 'Файл JSON пошкоджений. Виправ файл або повтори завантаження.'; // Пояснюємо синтаксично хибний JSON.
  return 'Не вдалося завантажити ресурси. Перевір з’єднання та повтори.'; // Даємо загальне повідомлення для мережевих помилок.
} // Завершуємо перетворення помилки.

// Розблоковуємо звук синхронно з першим кліком і лише потім починаємо мережу.
document.getElementById('startButton').addEventListener(
  'click',
  async () => {
    await audio.unlock(); // Створюємо AudioContext у межах користувацького жесту.
    document.getElementById('startScreen').hidden = true; // Ховаємо стартовий екран після дозволу браузера.
    boot(); // Починаємо асинхронне завантаження після розблокування звуку.
  },
  { once: true },
); // Ігровий цикл може стартувати лише один раз.

// Кнопка скасування перериває всі fetch-запити й повторні спроби активів.
document.getElementById('cancelLoading').addEventListener('click', () => loadController?.abort()); // Сигнал зупиняє поточний pipeline.

// Кнопка виходу закриває сокет і повертає гравця в список кімнат.
document.getElementById('leaveGameBtn').addEventListener('click', () => {
  loop.stop(); // Зупиняємо рендер гри.
  playing = false; // Вимикаємо ігровий стан.
  session?.leave(); // Закриваємо WebSocket і звільняємо кімнату на сервері.
  session = null; // Прибираємо застаріле посилання на сесію.
  document.getElementById('chatBox').hidden = true; // Ховаємо чат.
  document.getElementById('leaveGameBtn').hidden = true; // Ховаємо кнопку виходу.
  document.getElementById('lobby').hidden = false; // Повертаємо лобі.
  lobbyView.show(); // Оновлюємо список доступних кімнат.
}); // Завершуємо вихід із матчу.
