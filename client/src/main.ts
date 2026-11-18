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
import { NetworkGame } from './net/game.js'; // Передбачає власний рух і малює серверні знімки.
import type { LobbyNetworkOptions, LobbyRoom } from './lobby.js';
import type { Ship as LocalShip } from './entities.js';
import { isAssetManifest } from './utils/loader.js';

interface ArenaConfig {
  readonly asteroidCount: number;
}
interface JoinRequest {
  readonly room: LobbyRoom;
  readonly name: string;
  readonly arena?: ArenaConfig;
  readonly network: LobbyNetworkOptions;
}

function requiredElement<ElementType extends HTMLElement>(
  id: string,
  constructor: { new (): ElementType },
): ElementType {
  const element = document.getElementById(id);
  if (!(element instanceof constructor)) throw new Error('Не знайдено елемент #' + id);
  return element;
}

function getContext2d(canvasElement: HTMLCanvasElement): CanvasRenderingContext2D {
  const context = canvasElement.getContext('2d');
  if (!context) throw new Error('Не вдалося створити Canvas 2D контекст');
  return context;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isArenaConfig(value: unknown): value is ArenaConfig {
  return (
    isRecord(value) &&
    typeof value.asteroidCount === 'number' &&
    Number.isInteger(value.asteroidCount) &&
    value.asteroidCount >= 0 &&
    value.asteroidCount <= 100
  );
}

function isLobbyNetworkOptions(value: unknown): value is LobbyNetworkOptions {
  if (!isRecord(value)) return false;
  const validOptionalBoolean = (key: string): boolean => value[key] === undefined || typeof value[key] === 'boolean';
  const validOptionalNumber = (key: string, maximum: number): boolean =>
    value[key] === undefined ||
    (typeof value[key] === 'number' && Number.isFinite(value[key]) && value[key] >= 0 && value[key] <= maximum);
  return (
    validOptionalBoolean('authoritative') &&
    validOptionalBoolean('prediction') &&
    (value.format === undefined || value.format === 'binary' || value.format === 'json') &&
    validOptionalNumber('latencyMs', 500) &&
    validOptionalNumber('jitterMs', 200) &&
    validOptionalNumber('packetLoss', 1)
  );
}

function isJoinRequest(value: unknown): value is JoinRequest {
  if (!isRecord(value) || !isRecord(value.room) || !isLobbyNetworkOptions(value.network)) return false;
  const room = value.room;
  return (
    typeof room.id === 'string' &&
    typeof room.name === 'string' &&
    typeof room.players === 'number' &&
    typeof room.maxPlayers === 'number' &&
    (room.arena === undefined || isArenaConfig(room.arena)) &&
    typeof value.name === 'string'
  );
}

function isRoster(value: unknown): value is { readonly players: readonly { readonly name: string }[] } {
  return (
    isRecord(value) &&
    Array.isArray(value.players) &&
    value.players.every((player: unknown) => isRecord(player) && typeof player.name === 'string')
  );
}

// Знаходимо полотно та контекст малювання один раз під час старту модуля.
const canvas = requiredElement('gameCanvas', HTMLCanvasElement); // Canvas показує арену.
const ctx = getContext2d(canvas); // Контекст 2D надає команди малювання.
const hudElement = requiredElement('hud', HTMLElement); // Контейнер статистики та рахунку.
const input = createInput(window); // Замикання слухає клавіатуру в браузерному вікні.
const audio = createAudioEngine(); // Контекст звуку поки що не створюється.
let width = 0; // Ширина полотна в CSS-пікселях.
let height = 0; // Висота полотна в CSS-пікселях.
let world: World | null = null; // World буде створений після вимірювання canvas.
let ship: LocalShip | null = null; // Посилання на поточний корабель гравця.
let lobby: Lobby | null = null; // Lobby живе, поки гравець перебуває на екрані кімнат.
let lobbyView: ReturnType<typeof createLobbyView> | null = null; // DOM-подання лобі має окремі команди show та hide.
let session: ReturnType<typeof startSession> | null = null; // WebSocket-сесія відкривається після вибору кімнати.
let networkGame: NetworkGame | null = null; // Мережева симуляція з'являється після входу до кімнати.
let playing = false; // Прапорець вмикає симуляцію після натискання Join.
let loadController: AbortController | null = null; // Контролер дозволяє скасувати поточне завантаження.
let respawnTime = 0; // Таймер відродження корабля вимірюється в секундах.
let asteroidTimer = 0; // Таймер періодичного створення перешкод.
let defaultArena: ArenaConfig = { asteroidCount: 5 }; // Статичний arena.json задає значення за замовчуванням.
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
  networkGame?.setViewport(width, height); // Мережева арена масштабується під новий розмір вікна.
} // Завершуємо підлаштування canvas.

window.addEventListener('resize', resizeCanvas); // Повторно налаштовуємо bitmap при зміні розміру вікна.
resizeCanvas(); // Налаштовуємо canvas до створення гри.
world = new World(width, height); // Створюємо світ після того, як відомі межі.
ship = new Ship(width / 2, height / 2); // Ставимо перший корабель у центр арени.
world.spawn(ship); // Додаємо гравця до entity store.

// Шукаємо безпечну точку для респауну, подалі від астероїдів.
function findSafeSpawn() {
  const activeWorld = world;
  if (!activeWorld) return { x: width / 2, y: height / 2 };
  for (let attempt = 0; attempt < 50; attempt += 1) {
    // Обмежуємо кількість випадкових перевірок.
    const point = { x: Math.random() * width, y: Math.random() * height }; // Випадково обираємо кандидата.
    const safe = [...activeWorld.ofKind('asteroid')].every(
      (asteroid) => Math.hypot(asteroid.pos.x - point.x, asteroid.pos.y - point.y) > asteroid.radius + 80,
    ); // Відкидаємо точки біля перешкод.
    if (safe) return point; // Повертаємо першу безпечну позицію.
  } // Завершуємо обмежений пошук.
  return { x: width / 2, y: height / 2 }; // У переповненій арені використовуємо центр як запасний варіант.
} // Завершуємо пошук точки.

// Оновлюємо стан симуляції одним кроком у 1/60 секунди.
function simulate(dt: number): void {
  if (!playing) return; // Не рухаємо корабель до вибору кімнати або після виходу.
  const activeWorld = world;
  const activeShip = ship;
  if (!activeWorld || !activeShip) return;
  const commands = {
    left: input.isDown('ArrowLeft'),
    right: input.isDown('ArrowRight'),
    thrust: input.isDown('ArrowUp'),
    firePressed: input.justPressed('Space'),
  }; // Зчитуємо клавіші один раз за крок.
  if (networkGame) {
    if (commands.firePressed) networkGame.queueFire(); // Локально показуємо постріл одразу, не чекаючи сервера.
    networkGame.update(dt, {
      gas: commands.thrust,
      turn: commands.right === commands.left ? 0 : commands.right ? 1 : -1,
    }); // Надсилаємо тільки кнопки та прогнозуємо свій фіксований крок.
    input.clearJustPressed(); // Одноразовий постріл не повторюється в наступному кадрі.
    return; // Сервер керує всіма сутностями, тож локальний World тут не рухає корабель.
  }
  activeWorld.step(dt, commands); // Передаємо чистий стан вводу у світ.
  input.clearJustPressed(); // Одноразові клавіші не повторюються в наступному кроці.
  if (activeShip.isDead) {
    // Починаємо відлік лише після першої смерті.
    if (respawnTime === 0) respawnTime = 2; // Вимога лабораторної задає дві секунди до респауну.
    respawnTime -= dt; // Відраховуємо фіксований час симуляції.
    if (respawnTime <= 0) {
      const point = findSafeSpawn();
      ship = new Ship(point.x, point.y);
      activeWorld.spawn(ship);
      respawnTime = 0;
    } // Створюємо корабель у безпечному місці.
  } // Завершуємо контроль респауну.
  asteroidTimer += dt; // Накопичуємо час до наступної перешкоди.
  if (asteroidTimer >= 2) {
    const asteroid = new Asteroid(Math.random() * width, 0, 16);
    const homingTarget = ship ?? activeShip;
    if (Math.random() < 0.2) withHoming(asteroid, homingTarget, 20);
    activeWorld.spawn(asteroid);
    asteroidTimer = 0;
  } // Додаємо звичайний або самонавідний астероїд.
} // Завершуємо крок симуляції.

// Малюємо інтерпольований стан світу, щоб корабель був плавним і на 120 Hz.
function render(alpha: number): void {
  if (networkGame) {
    networkGame.render(ctx); // Мережевий світ малює свій корабель і серверні знімки.
    return;
  }
  world?.render(ctx, alpha); // World використовує alpha між попереднім і поточним станом.
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
function addChatMessage(sender: string, message: string): void {
  const list = requiredElement('chatMessages', HTMLElement); // Знаходимо список повідомлень.
  const row = document.createElement('p'); // Створюємо безпечний текстовий рядок.
  row.textContent = sender + ': ' + message; // textContent не інтерпретує текст як HTML.
  list.append(row); // Додаємо повідомлення в кінець чату.
  list.scrollTop = list.scrollHeight; // Прокручуємо список до нового рядка.
} // Завершуємо додавання повідомлення.

// Надсилаємо текст чату через API активної кімнатної сесії.
requiredElement('chatForm', HTMLFormElement).addEventListener('submit', (event) => {
  event.preventDefault(); // Не перезавантажуємо сторінку через HTML-форму.
  const field = requiredElement('chatInput', HTMLInputElement); // Беремо поле введення повідомлення.
  const text = field.value.trim(); // Відкидаємо порожній текст і пробіли по краях.
  if (!text || !session) return; // Не надсилаємо порожні рядки або повідомлення поза кімнатою.
  session.sendChat(text); // Клієнтська сесія поставить повідомлення в чергу сокета.
  field.value = ''; // Очищаємо поле після надсилання.
}); // Завершуємо обробник форми чату.

// Показуємо в HUD список гравців, які вже зайшли в кімнату.
function showRoster(players: readonly { readonly name: string }[] = []): void {
  const roster = document.getElementById('roomRoster'); // Знаходимо місце для учасників кімнати.
  if (roster) roster.textContent = 'У кімнаті: ' + players.map((player) => player.name).join(', '); // Відображаємо лише перевірені текстові імена.
} // Завершуємо оновлення списку.

// Стартуємо локальний матч після натискання Join у лобі.
function joinGame({ room, name, arena, network }: JoinRequest): void {
  playing = true; // Дозволяємо симуляції й рендеру початися.
  hud.setName(name); // Показуємо ім'я власного корабля.
  lobbyView?.hide(); // Приховуємо список кімнат і скасовуємо його запит.
  session?.leave(); // Закриваємо попередню сесію, якщо вона існувала.
  networkGame = network.authoritative ? new NetworkGame({ prediction: network.prediction !== false }) : null; // Без галочки запускається початкова гра лабораторної 4.
  networkGame?.setViewport(width, height); // Мережевій грі потрібен розмір canvas для масштабу арени.
  session = startSession({
    roomId: room.id,
    name,
    format: network.format ?? 'binary',
    network: {
      latencyMs: Number(network.latencyMs ?? 0),
      jitterMs: Number(network.jitterMs ?? 0),
      packetLoss: Number(network.packetLoss ?? 0),
    },
    onRoster: (message) => showRoster(message.players),
    onChat: (message) => addChatMessage(message.sender, message.text),
    onJoined: (message) => {
      networkGame?.initialize(message); // Починаємо прогноз із стану, який видав сервер.
      hud.setGameState(message.state); // Починаємо новий матч із життями та рахунком із сервера.
      showRoster(message.players);
    },
    onSnapshot: (snapshot) => networkGame?.receiveSnapshot(snapshot), // Звіряємо локальний стан зі знімком.
    onPong: (message) => networkGame?.receivePong(message), // RTT вимірюється запитом і відповіддю сервера.
    onBytes: (count) => networkGame?.graph.addBytes(count), // Рахуємо отриманий і відправлений трафік.
    onStatus: (status, data) => {
      if (status === 'joined' && isRoster(data)) showRoster(data.players);
    },
  }); // Приєднуємося до сервера та слухаємо кімнатні події.
  networkGame?.setInputSender(session.sendInput); // У мережевому режимі передаємо кнопки серверу.
  if (!networkGame) {
    world = new World(width, height); // Повертаємо локальну модель світу лабораторної 4.
    ship = new Ship(width / 2, height / 2); // Створюємо корабель локального матчу.
    world.spawn(ship); // Додаємо корабель у той самий World, що використовувався до лабораторної 5.
    respawnTime = 0; // Новий матч починається без старого таймера респауну.
    asteroidTimer = 0; // Перший додатковий астероїд з'явиться через стандартні дві секунди.
    const count = Number(arena?.asteroidCount ?? defaultArena.asteroidCount) || 5; // Беремо кількість із arena.json, як у лабораторній 4.
    for (let index = 0; index < count; index += 1) {
      world.spawn(new Asteroid(Math.random() * width, Math.random() * height, 16)); // Локальна гра зберігає свої рухомі астероїди та homing.
    }
  }
  requiredElement('chatBox', HTMLElement).hidden = false; // Відкриваємо чат після входу.
  requiredElement('leaveGameBtn', HTMLButtonElement).hidden = false; // Показуємо вихід із кімнати.
  loop.start(); // Починаємо rAF лише після вибору кімнати.
} // Завершуємо запуск матчу.

// Завантажуємо активи й після цього готуємо лобі.
async function boot() {
  const controller = new AbortController(); // Створюємо окреме скасування для цього завантаження.
  loadController = controller;
  const signal = controller.signal; // Передаємо один сигнал усім мережевим запитам.
  const params = new URLSearchParams(location.search); // Читаємо необов'язкові режими демонстрації з URL.
  const failure = params.get('fail'); // Режим fail дає відтворити сценарії з README.
  const loadingControls = requiredElement('loadingControls', HTMLElement); // Знаходимо статус і кнопку скасування.
  loadingControls.hidden = false; // Показуємо керування завантаженням.
  try {
    // Перехоплюємо мережеві помилки й показуємо зрозумілий Retry.
    drawLoading(0, 1, 'manifest'); // Відображаємо перший етап прогресу.
    const rawManifest = await loadJson('/assets/manifest.json', signal); // Завантажуємо єдиний опис усіх файлів.
    if (!isAssetManifest(rawManifest)) throw new TypeError('Некоректний manifest активів');
    const manifest = {
      images: { ...rawManifest.images },
      sounds: { ...rawManifest.sounds },
      json: { ...rawManifest.json },
    };
    if (failure === '404') manifest.images.hero = '/assets/not-found.png'; // Підміняємо спрайт на відсутній для досліду 404.
    if (failure === 'timeout') manifest.json.arena = '/api/demo/slow?delay=3000'; // Підміняємо JSON ресурс локальним повільним маршрутом.
    if (failure === 'json') manifest.json.arena = '/assets/broken-json.txt'; // Підміняємо JSON ресурс пошкодженим текстом.
    const timeoutMs = failure === 'timeout' ? 250 : 5000; // Робимо контрольований короткий timeout лише в демонстрації.
    if (failure === 'abort') setTimeout(() => loadController?.abort(), 150); // Автоматично перериваємо режим демонстрації abort посеред завантаження.
    const audioContext = audio.context;
    if (!audioContext) throw new Error('Спочатку потрібно розблокувати звук');
    const loaded = await loadAll(manifest, {
      audioCtx: audioContext,
      signal,
      timeoutMs,
      debugDelayMs: failure === 'abort' ? 1000 : 0,
      onProgress: (done, total, file) => drawLoading(done, total, file),
    }); // Чекаємо всі ресурси й показуємо прогрес для кожного.
    const loadedArena = loaded.json.arena;
    if (isArenaConfig(loadedArena)) defaultArena = loadedArena; // Зберігаємо лише перевірений arena.json.
    Object.assign(sprites, loaded.images); // Передаємо зображення в модуль рендеру.
    audio.setBuffers(loaded.sounds); // Зберігаємо декодовані аудіобуфери.
    loadingControls.hidden = true; // Ховаємо індикатор після успішного завантаження.
    const activeLobby = new Lobby(); // Створюємо модель лобі без DOM-залежностей.
    lobby = activeLobby;
    const activeLobbyView = createLobbyView(activeLobby, requiredElement('lobby', HTMLElement)); // Будуємо DOM лобі в окремому модулі.
    lobbyView = activeLobbyView;
    activeLobby.addEventListener('joined', (event) => {
      if (event instanceof CustomEvent && isJoinRequest(event.detail)) joinGame(event.detail);
    }); // Зв'язуємо вибір кімнати зі стартом гри.
    activeLobbyView.show(); // Показуємо лобі й запускаємо перший HTTP-запит.
  } catch (error: unknown) {
    // Всі помилки активів ведуть на екран повтору.
    controller.abort(); // Скасовуємо всі паралельні запити після першої помилки.
    loadingControls.hidden = true; // Прибираємо кнопку скасування після завершення спроби.
    showError(requiredElement('errorScreen', HTMLElement), describeError(error), () => void boot()); // Показуємо повідомлення й запускаємо нову спробу після кліку.
  } // Завершуємо обробку помилок завантаження.
} // Завершуємо boot.

// Малюємо справжній прогрес завантаження на полотні.
function drawLoading(done: number, total: number, label: string): void {
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
function describeError(error: unknown): string {
  if (!(error instanceof Error)) return 'Не вдалося завантажити ресурси. Перевір з’єднання та повтори.';
  if (error.name === 'AbortError') return 'Завантаження скасовано. Натисни «Повторити», щоб почати знову.'; // Пояснюємо ручний або тестовий abort.
  if (error.name === 'TimeoutError') return 'Сервер не відповів вчасно. Перевір з’єднання та повтори.'; // Пояснюємо таймаут мережі.
  if (error.name === 'HttpError' && 'status' in error && typeof error.status === 'number')
    return 'Не вдалося завантажити файл (HTTP ' + error.status + '). Перевір адресу та повтори.'; // Пояснюємо 4xx/5xx відповідь.
  if (error.name === 'SyntaxError') return 'Файл JSON пошкоджений. Виправ файл або повтори завантаження.'; // Пояснюємо синтаксично хибний JSON.
  return 'Не вдалося завантажити ресурси. Перевір з’єднання та повтори.'; // Даємо загальне повідомлення для мережевих помилок.
} // Завершуємо перетворення помилки.

// Розблоковуємо звук синхронно з першим кліком і лише потім починаємо мережу.
requiredElement('startButton', HTMLButtonElement).addEventListener(
  'click',
  async () => {
    await audio.unlock(); // Створюємо AudioContext у межах користувацького жесту.
    requiredElement('startScreen', HTMLElement).hidden = true; // Ховаємо стартовий екран після дозволу браузера.
    await boot(); // Починаємо асинхронне завантаження після розблокування звуку.
  },
  { once: true },
); // Ігровий цикл може стартувати лише один раз.

// Кнопка скасування перериває всі fetch-запити й повторні спроби активів.
requiredElement('cancelLoading', HTMLButtonElement).addEventListener('click', () => loadController?.abort()); // Сигнал зупиняє поточний pipeline.

// Кнопка виходу закриває сокет і повертає гравця в список кімнат.
requiredElement('leaveGameBtn', HTMLButtonElement).addEventListener('click', () => {
  loop.stop(); // Зупиняємо рендер гри.
  playing = false; // Вимикаємо ігровий стан.
  session?.leave(); // Закриваємо WebSocket і звільняємо кімнату на сервері.
  session = null; // Прибираємо застаріле посилання на сесію.
  networkGame = null; // Прибираємо передбачення й історію знімків попереднього матчу.
  requiredElement('chatBox', HTMLElement).hidden = true; // Ховаємо чат.
  requiredElement('leaveGameBtn', HTMLButtonElement).hidden = true; // Ховаємо кнопку виходу.
  requiredElement('lobby', HTMLElement).hidden = false; // Повертаємо лобі.
  lobbyView?.show(); // Оновлюємо список доступних кімнат.
}); // Завершуємо вихід із матчу.
