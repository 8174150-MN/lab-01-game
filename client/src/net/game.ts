// Клієнтський мережевий світ передбачає власний рух і згладжує решту гравців.
import {
  ARENA_HEIGHT,
  ARENA_WIDTH,
  FIXED_DT,
  createShipState,
  createBullet,
  isInputAcknowledged,
  integrate,
  integrateBulletInto,
  integrateInto,
  integrateBullet,
  interpolateAngle,
  reconcilePrediction,
  wrapCoordinate,
  wrappedDelta,
  type MutableBulletMotion,
  type MutableShipMotion,
} from '@dogfight/shared/engine';
import { NetGraph } from '../netgraph.js';
import { markProfileEnd, markProfileStart } from '../diagnostics/performance.js'; // Позначаємо звірку стану, коли увімкнено профіль.
import { sprites, drawSprite, fullSpriteFrame } from '../sprites.js'; // Використовуємо кешовані рамки sprite sheets.
import type { SpriteFrame } from '../sprites.js';
import { emit } from '../events.js'; // Повідомляємо наявну звукову шину та HUD про мережеві події.
import {
  asSeq,
  type AsteroidEntity,
  type BulletEntity,
  type EntityId,
  type InputCommand,
  type Seq,
  type ShipEntity,
  type ShipState,
  type Snapshot,
} from '@dogfight/shared/types';
import type { JoinedMessage } from '@dogfight/shared/protocol';

const renderAllocationBaseline =
  typeof globalThis.location !== 'undefined' &&
  new URLSearchParams(globalThis.location.search).get('lab7-render-baseline') === '1'; // Повертає старий рендер лише для контрольного виміру до оптимізації.
const bulletSpriteFrames: readonly SpriteFrame[] = [
  { x: 0, y: 0, w: 32, h: 32 },
  { x: 32, y: 0, w: 32, h: 32 },
  { x: 64, y: 0, w: 32, h: 32 },
  { x: 96, y: 0, w: 32, h: 32 },
]; // Кадри sprite sheet куль створюються один раз при завантаженні модуля.
const SNAPSHOT_HISTORY_LIMIT = 8; // Восьми станів вистачає для інтерполяції й вони не тримають старі об'єкти довго.

interface NetworkControls {
  gas: boolean;
  turn: -1 | 0 | 1;
}
interface SnapshotEntry {
  readonly receivedAt: number;
  readonly snapshot: Snapshot;
}
interface InterpolationPair {
  first: SnapshotEntry;
  second: SnapshotEntry;
  alpha: number;
}
type BulletRenderState = Pick<BulletEntity, 'x' | 'y' | 'vx' | 'vy' | 'ttl'>;
interface Effect {
  x: number;
  y: number;
  vx: number;
  vy: number;
  ttl: number;
}
interface NetworkGameOptions {
  readonly prediction?: boolean;
  readonly onInput?: (input: InputCommand) => void;
}
type PredictedBullet = BulletEntity & { readonly seq: Seq };

// Залишаємо в клієнтському стані лише поля, які сервер реально передає.
function copyShipState(
  player: Pick<ShipEntity, 'x' | 'y' | 'vx' | 'vy' | 'angle' | 'hp' | 'score' | 'respawnTicks' | 'ackSeq'>,
): ShipState {
  return {
    kind: 'ship',
    x: player.x,
    y: player.y,
    vx: player.vx,
    vy: player.vy,
    angle: player.angle,
    hp: player.hp,
    score: player.score,
    respawnTicks: player.respawnTicks,
    ackSeq: player.ackSeq,
  };
}

// Один NetworkGame відповідає за передбачення, звірку та мережеве малювання.
export class NetworkGame {
  prediction: boolean;
  onInput: (input: InputCommand) => void;
  graph: NetGraph;
  playerId: EntityId | null;
  localState: ShipState | null;
  inputHistory: InputCommand[];
  nextSeq: Seq;
  accumulator: number;
  fireQueued: boolean;
  predictedBullets: Map<EntityId, BulletEntity>;
  snapshotHistory: SnapshotEntry[];
  renderWidth: number;
  renderHeight: number;
  correctionX: number;
  correctionY: number;
  correctionAngle: number;
  lastAuthoritativeState: ShipState | null;
  lastAsteroids: Map<EntityId, AsteroidEntity>;
  effects: Effect[];
  effectPool: Effect[];
  thrusting: boolean;
  renderInput: NetworkControls;
  #renderShipMotion: MutableShipMotion = { x: 0, y: 0, vx: 0, vy: 0, angle: 0 }; // Інтерполяція прогнозу повторно використовує цей стан.
  #renderBulletMotion: MutableBulletMotion = { x: 0, y: 0, vx: 0, vy: 0, ttl: 0 }; // Кулі теж рендеряться через один scratch.
  #interpolationScratch: InterpolationPair | null = null; // Пара snapshot змінює поля замість нової структури щокадру.
  #arenaCanvas: HTMLCanvasElement | null = null; // Статичне зоряне поле малюється в кеш один раз.

  constructor({ prediction = true, onInput = () => {} }: NetworkGameOptions = {}) {
    this.prediction = prediction;
    this.onInput = onInput;
    this.graph = new NetGraph();
    this.playerId = null;
    this.localState = null;
    this.inputHistory = [];
    this.nextSeq = asSeq(0);
    this.accumulator = 0;
    this.fireQueued = false;
    this.predictedBullets = new Map();
    this.snapshotHistory = [];
    this.renderWidth = 1280;
    this.renderHeight = 720;
    this.correctionX = 0;
    this.correctionY = 0;
    this.correctionAngle = 0;
    this.lastAuthoritativeState = null;
    this.lastAsteroids = new Map();
    this.effects = [];
    this.effectPool = []; // Повторно використовуємо короткоживучі частинки в мережевому рендері.
    this.thrusting = false;
    this.renderInput = { gas: false, turn: 0 };
  }

  // З'єднання задається після створення сесії, коли стала відома її sendInput-функція.
  setInputSender(sendInput: (input: InputCommand) => void): void {
    this.onInput = sendInput;
  }

  // Запам'ятовуємо розмір вікна, щоб масштабувати фіксовану арену.
  setViewport(width: number, height: number): void {
    this.renderWidth = width;
    this.renderHeight = height;
  }

  // Починаємо локальний стан із серверного привітання, а не з даних браузера.
  initialize(welcome: JoinedMessage): void {
    this.playerId = welcome.playerId;
    this.nextSeq = welcome.state?.ackSeq ?? 0;
    this.localState = welcome.state ? copyShipState(welcome.state) : createShipState(ARENA_WIDTH / 2, ARENA_HEIGHT / 2); // Показуємо власний корабель, навіть якщо старий сервер ще не надіслав стартовий стан.
    this.inputHistory.length = 0;
    this.snapshotHistory.length = 0;
    this.predictedBullets.clear();
    this.correctionX = 0;
    this.correctionY = 0;
    this.correctionAngle = 0;
    this.accumulator = 0;
    const initialState = this.localState;
    if (!initialState) return;
    this.lastAuthoritativeState = copyShipState(initialState);
    this.lastAsteroids.clear();
    this.#clearEffects(); // Звільняємо активні частинки до пулу, не втрачаючи їхні об'єкти.
    this.thrusting = false;
    emit('shipSpawned', { hp: initialState.hp }); // Оновлюємо життя в тому самому HUD, що й до мережевого режиму.
    if (welcome.snapshot) this.receiveSnapshot(welcome.snapshot); // Початковий знімок одразу показує астероїди й інших пілотів.
  }

  // Запам'ятовуємо натискання пробілу до наступного мережевого кроку.
  queueFire(): void {
    this.fireQueued = true;
  }

  // Накопичуємо 60-герцові кадри й надсилаємо рівно один input на 30-герцовий крок.
  update(frameDt: number, controls: NetworkControls): void {
    if (!this.playerId || !this.localState) return;
    this.accumulator += frameDt;
    this.thrusting = Boolean(controls.gas); // Вогонь двигуна відповідає натисканню газу в мережевому режимі.
    this.renderInput.gas = Boolean(controls.gas); // Переиспользуем управляющий input між кадрами.
    this.renderInput.turn = controls.turn; // Оновлюємо поворот у тому самому об'єкті.
    this.correctionX *= Math.exp(-frameDt / 0.1);
    this.correctionY *= Math.exp(-frameDt / 0.1);
    this.correctionAngle *= Math.exp(-frameDt / 0.1);
    this.#stepEffects(frameDt); // Локальні частинки згасають плавно між серверними знімками.

    while (this.accumulator >= FIXED_DT) {
      this.accumulator -= FIXED_DT;
      this.#stepInput(controls);
    }
    this.graph.pendingInputCount = this.inputHistory.length;
  }

  // Застосовуємо input передбаченням, додаємо його до черги й відправляємо серверу.
  #stepInput(controls: NetworkControls): void {
    if (!this.localState || !this.playerId) return;
    this.nextSeq = asSeq((this.nextSeq + 1) >>> 0);
    const input = {
      seq: this.nextSeq,
      gas: Boolean(controls.gas),
      turn: controls.turn,
      shoot: this.fireQueued,
    };
    this.fireQueued = false;
    this.inputHistory.push(input);
    if (this.prediction) this.localState = integrate(this.localState, input, FIXED_DT);
    if (input.shoot) emit('fired', { x: this.localState.x, y: this.localState.y }); // Повторно використовуємо звук пострілу з лабораторної 4.

    for (const [id, bullet] of this.predictedBullets) {
      const nextBullet = integrateBullet(bullet, FIXED_DT);
      if (nextBullet.dead) this.predictedBullets.delete(id);
      else this.predictedBullets.set(id, nextBullet);
    }
    if (input.shoot && this.prediction) {
      const bullet = createBullet(this.localState, this.playerId, input.seq);
      this.predictedBullets.set(bullet.id, bullet);
    }

    this.onInput(input);
  }

  // RTT вимірюється від клієнтського ping до поверненої сервером мітки часу.
  receivePong(message: { readonly sentAt: number }): void {
    if (Number.isFinite(message.sentAt)) {
      this.graph.setRtt(Math.max(0, performance.now() - message.sentAt));
    }
  }

  // Додаємо знімок до історії, звіряємо свій стан і повторюємо непідтверджені input.
  receiveSnapshot(snapshot: Snapshot): void {
    if (!Array.isArray(snapshot.players) || !Array.isArray(snapshot.bullets)) return;
    markProfileStart('reconcile'); // Починаємо замір звірки з серверним snapshot.
    const receivedAt = performance.now();
    const previousSnapshot = this.snapshotHistory.at(-1)?.snapshot;
    this.graph.snapshotReceived();
    this.snapshotHistory.push({ receivedAt, snapshot });
    while (this.snapshotHistory.length > SNAPSHOT_HISTORY_LIMIT) this.snapshotHistory.shift();

    const asteroids = snapshot.asteroids ?? [];
    let asteroidExploded = false;
    for (const [id, asteroid] of this.lastAsteroids) {
      let stillExists = false;
      for (const current of asteroids) {
        if (current.id === id) {
          stillExists = true;
          break;
        }
      }
      if (stillExists) continue;
      this.#spawnExplosion(asteroid.x, asteroid.y);
      asteroidExploded = true;
    }
    this.lastAsteroids.clear(); // Повторно використовуємо Map замість створення нової на кожен знімок.
    for (const asteroid of asteroids) this.lastAsteroids.set(asteroid.id, asteroid); // П'ять астероїдів швидше звірити циклом без проміжного масиву.

    let serverPlayer: ShipEntity | undefined;
    for (const player of snapshot.players) {
      if (player.id === this.playerId) {
        serverPlayer = player;
        break;
      }
    }
    if (!serverPlayer) {
      markProfileEnd('reconcile'); // Закриваємо замір і для snapshot без локального корабля.
      return;
    }
    let remoteExploded = false;
    const previousPlayers = previousSnapshot?.players ?? [];
    for (const player of snapshot.players) {
      let previousPlayer: ShipEntity | undefined;
      for (const candidate of previousPlayers) {
        if (candidate.id === player.id) {
          previousPlayer = candidate;
          break;
        }
      }
      if (player.id === this.playerId || !previousPlayer || player.hp >= previousPlayer.hp) continue;
      emit('hit', { x: player.x, y: player.y, hp: player.hp, local: false }); // Звук є, але життя власника HUD не змінюються.
      if (player.hp === 0) {
        this.#spawnExplosion(player.x, player.y, 30);
        remoteExploded = true;
      }
    }
    const previousServerState = this.lastAuthoritativeState;
    let localExploded = false;
    if (previousServerState && serverPlayer.hp < previousServerState.hp) {
      emit('hit', { x: serverPlayer.x, y: serverPlayer.y, hp: serverPlayer.hp }); // Серверне влучання оновлює той самий HUD і звук.
      if (serverPlayer.hp === 0) {
        this.#spawnExplosion(serverPlayer.x, serverPlayer.y, 30);
        localExploded = true;
      }
    }
    if (previousServerState && previousServerState.hp <= 0 && serverPlayer.hp > 0) {
      emit('shipSpawned', { hp: serverPlayer.hp }); // Після серверного респауну життя знову видно в HUD.
    } else if (previousServerState && serverPlayer.hp > previousServerState.hp) {
      emit('healed', { hp: serverPlayer.hp }); // Сервер підтверджує підбір аптечки й оновлює HUD.
    }
    const scoreChanged = previousServerState && serverPlayer.score !== previousServerState.score;
    if (asteroidExploded || remoteExploded || localExploded || scoreChanged) {
      emit('exploded', { score: serverPlayer.score }); // Оновлюємо рахунок і звук після підтвердженого сервером вибуху.
    }
    this.lastAuthoritativeState = copyShipState(serverPlayer);
    const previousPrediction = this.localState;
    const acknowledged = serverPlayer.ackSeq;
    let pendingCount = 0;
    for (const input of this.inputHistory) {
      if (isInputAcknowledged(input.seq, acknowledged)) continue;
      this.inputHistory[pendingCount] = input;
      pendingCount += 1;
    }
    this.inputHistory.length = pendingCount; // Прибираємо підтверджений префікс без нового масиву filter().
    const serverState = copyShipState(serverPlayer);
    const correctedState = this.prediction ? reconcilePrediction(serverState, this.inputHistory) : serverState;

    if (previousPrediction && this.prediction) {
      const previousVisualX = wrapCoordinate(previousPrediction.x + this.correctionX, ARENA_WIDTH);
      const previousVisualY = wrapCoordinate(previousPrediction.y + this.correctionY, ARENA_HEIGHT);
      const previousVisualAngle = previousPrediction.angle + this.correctionAngle;
      this.correctionX = wrappedDelta(correctedState.x, previousVisualX, ARENA_WIDTH);
      this.correctionY = wrappedDelta(correctedState.y, previousVisualY, ARENA_HEIGHT);
      this.correctionAngle = Math.atan2(
        Math.sin(previousVisualAngle - correctedState.angle),
        Math.cos(previousVisualAngle - correctedState.angle),
      );
      this.graph.reconError = Math.hypot(this.correctionX, this.correctionY);
    } else {
      this.correctionX = 0;
      this.correctionY = 0;
      this.correctionAngle = 0;
      this.graph.reconError = previousPrediction
        ? Math.hypot(
            wrappedDelta(correctedState.x, previousPrediction.x, ARENA_WIDTH),
            wrappedDelta(correctedState.y, previousPrediction.y, ARENA_HEIGHT),
          )
        : 0;
    }
    this.localState = correctedState;

    for (const [id, bullet] of this.predictedBullets) {
      let confirmed = false;
      for (const serverBullet of snapshot.bullets) {
        if (serverBullet.id === id) {
          confirmed = true;
          break;
        }
      }
      if (confirmed || (bullet.seq !== undefined && isInputAcknowledged(bullet.seq, acknowledged))) {
        this.predictedBullets.delete(id);
      }
    }
    this.graph.pendingInputCount = this.inputHistory.length;
    markProfileEnd('reconcile'); // Завершуємо User Timing після повторного програвання непідтверджених input.
  }

  // Малюємо серверний світ, свій прогноз і панель мережевих показників.
  render(ctx: CanvasRenderingContext2D): void {
    ctx.clearRect(0, 0, this.renderWidth, this.renderHeight);
    ctx.fillStyle = '#0b0c10';
    ctx.fillRect(0, 0, this.renderWidth, this.renderHeight);
    ctx.save();
    ctx.scale(this.renderWidth / ARENA_WIDTH, this.renderHeight / ARENA_HEIGHT);
    this.#drawArena(ctx);
    this.#drawAsteroids(ctx);
    this.#drawPickups(ctx);
    this.#drawEffects(ctx);
    this.#drawRemoteShips(ctx);
    this.#drawServerBullets(ctx);
    this.#drawPredictedShip(ctx);
    this.#drawPredictedBullets(ctx);
    ctx.restore();
    this.graph.draw(ctx, !renderAllocationBaseline); // Baseline малює мережевий текст напряму, фінальна версія використовує кеш.
  }

  // Малюємо статичні зірки, щоб арена мала впізнаваний фон.
  #drawArena(ctx: CanvasRenderingContext2D): void {
    if (renderAllocationBaseline || typeof document === 'undefined') {
      ctx.fillStyle = 'rgba(255,255,255,0.28)'; // Baseline та нестандартний runtime малюють початковий варіант.
      for (let index = 0; index < 90; index += 1)
        ctx.fillRect((index * 137) % ARENA_WIDTH, (index * 83) % ARENA_HEIGHT, 2, 2); // Зберігаємо звичний малюнок зірок.
      return; // Повертаємося до повного шляху лише в контрольному режимі.
    } // Завершуємо baseline.
    if (!this.#arenaCanvas) {
      const field = document.createElement('canvas'); // Створюємо невелике offscreen-полотно один раз.
      field.width = ARENA_WIDTH; // Кеш має ті самі координати, що й серверна арена.
      field.height = ARENA_HEIGHT; // Кеш не залежить від розміру вікна браузера.
      const fieldContext = field.getContext('2d'); // Готуємо контекст лише для створення фону.
      if (fieldContext) {
        fieldContext.fillStyle = 'rgba(255,255,255,0.28)'; // Зберігаємо попередній колір зірок.
        for (let index = 0; index < 90; index += 1)
          fieldContext.fillRect((index * 137) % ARENA_WIDTH, (index * 83) % ARENA_HEIGHT, 2, 2); // Малюємо сталі точки один раз.
        this.#arenaCanvas = field; // Залишаємо заповнений bitmap для наступних кадрів.
      } // Завершуємо заповнення кешу.
    } // Створюємо фон тільки перед першим кадром.
    if (this.#arenaCanvas) {
      ctx.drawImage(this.#arenaCanvas, 0, 0); // Один blit замінює дев'яносто fillRect викликів.
      return; // Зоряне поле вже намальоване.
    } // Завершуємо cached path.
    ctx.fillStyle = 'rgba(255,255,255,0.28)';
    for (let index = 0; index < 90; index += 1)
      ctx.fillRect((index * 137) % ARENA_WIDTH, (index * 83) % ARENA_HEIGHT, 2, 2); // Якщо canvas недоступний, лишаємо старий рендер.
  }

  // Малюємо астероїди з серверного знімка, а не створюємо окремі локальні камені.
  #drawAsteroids(ctx: CanvasRenderingContext2D): void {
    const pair = this.#interpolationPair();
    if (!pair) return;
    const previousAsteroids = pair.first.snapshot.asteroids;
    const nextAsteroids = pair.second.snapshot.asteroids;
    if (renderAllocationBaseline) {
      const byId = new Map(nextAsteroids.map((asteroid) => [asteroid.id, asteroid])); // Baseline створює Map і масиви для пошуку.
      for (const previous of previousAsteroids) {
        const next = byId.get(previous.id) ?? previous;
        const asteroid = {
          ...previous,
          x: previous.x + (next.x - previous.x) * pair.alpha,
          y: previous.y + (next.y - previous.y) * pair.alpha,
        }; // Залишаємо старий тимчасовий об'єкт.
        this.#drawAsteroid(ctx, asteroid.x, asteroid.y, asteroid.radius, asteroid.homing); // Малюємо його тим самим способом.
      }
      return;
    }
    for (const previous of previousAsteroids) {
      let next = previous;
      for (const candidate of nextAsteroids) {
        if (candidate.id === previous.id) {
          next = candidate;
          break;
        }
      }
      const x = previous.x + (next.x - previous.x) * pair.alpha;
      const y = previous.y + (next.y - previous.y) * pair.alpha;
      this.#drawAsteroid(ctx, x, y, previous.radius, previous.homing); // Пошук по короткому списку не створює Map або сутність.
    }
  }

  // Малюємо астероїд за скалярами, не збираючи новий об'єкт на кожен кадр.
  #drawAsteroid(ctx: CanvasRenderingContext2D, x: number, y: number, radius: number, homing: boolean): void {
    const image = sprites.asteroid;
    if (image) {
      const frame = fullSpriteFrame(image); // Source rectangle стабільний для всієї текстури.
      const size = radius * 2.4;
      if (renderAllocationBaseline)
        drawSprite(ctx, image, x, y, size, size, 0, frame); // Baseline лишає початкові зайві перетворення canvas.
      else ctx.drawImage(image, frame.x, frame.y, frame.w, frame.h, x - size / 2, y - size / 2, size, size); // Нульовий поворот не потребує окремих save/translate/rotate.
    } else {
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.strokeStyle = '#aaa';
      ctx.stroke();
    } // Запасне коло видно лише тоді, коли файл спрайта недоступний.
    if (homing) {
      ctx.beginPath();
      ctx.arc(x, y, radius + 4, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(255, 140, 66, 0.65)';
      ctx.lineWidth = 2;
      ctx.stroke();
    } // Помаранчева обводка показує самонавідну перешкоду.
  } // Завершуємо малювання одного астероїда.

  // Малюємо аптечки тим самим зеленим знаком, що й локальна гра.
  #drawPickups(ctx: CanvasRenderingContext2D): void {
    const pickups = this.snapshotHistory.at(-1)?.snapshot.pickups ?? [];
    for (const pickup of pickups) {
      ctx.fillStyle = '#4ade80';
      ctx.fillRect(pickup.x - 5, pickup.y - 5, 10, 10);
      ctx.fillStyle = '#0b0c10';
      ctx.font = 'bold 10px monospace';
      ctx.textAlign = 'center';
      ctx.fillText('+', pickup.x, pickup.y + 4);
    }
  }

  // Беремо стан інших кораблів за 100 мілісекунд до поточного часу й інтерполюємо його.
  #drawRemoteShips(ctx: CanvasRenderingContext2D): void {
    const pair = this.#interpolationPair();
    if (!pair) return;
    const firstPlayers = pair.first.snapshot.players;
    const secondPlayers = pair.second.snapshot.players;
    if (renderAllocationBaseline) {
      const firstById = new Map(firstPlayers.map((player) => [player.id, player])); // Baseline повторює Map та масиви зі старого рендеру.
      const secondById = new Map(secondPlayers.map((player) => [player.id, player])); // Створюємо такі самі тимчасові структури, як до оптимізації.
      for (const [id, second] of secondById) {
        this.#drawRemoteShip(ctx, second, firstById.get(id), pair.alpha); // Малюємо baseline з попереднім Map-пошуком.
      }
      return;
    }
    for (const second of secondPlayers) {
      let previous: (typeof firstPlayers)[number] | undefined;
      for (const candidate of firstPlayers) {
        if (candidate.id === second.id) {
          previous = candidate;
          break;
        }
      }
      this.#drawRemoteShip(ctx, second, previous, pair.alpha); // Пошук лінійним циклом не виділяє Map у кожному кадрі.
    }
  }

  // Малюємо один віддалений корабель для обох режимів порівняння.
  #drawRemoteShip(
    ctx: CanvasRenderingContext2D,
    second: ShipEntity,
    previous: ShipEntity | undefined,
    alpha: number,
  ): void {
    if (second.id === this.playerId || second.hp <= 0) return; // Не дублюємо власний або знищений корабель.
    const first = !previous || previous.hp <= 0 ? second : previous; // Після респауну починаємо інтерполяцію з нового стану.
    const x = wrapCoordinate(first.x + wrappedDelta(first.x, second.x, ARENA_WIDTH) * alpha, ARENA_WIDTH);
    const y = wrapCoordinate(first.y + wrappedDelta(first.y, second.y, ARENA_HEIGHT) * alpha, ARENA_HEIGHT);
    const angle = interpolateAngle(first.angle, second.angle, alpha);
    const isThrusting = renderAllocationBaseline
      ? Math.hypot(second.vx, second.vy) > 10
      : second.vx * second.vx + second.vy * second.vy > 100; // Квадрат порогу не викликає sqrt на кожного корабля у фінальному режимі.
    this.#drawShip(ctx, x, y, angle, second.name, second.hp, isThrusting);
  } // Завершуємо інтерпольоване малювання корабля.

  // Знаходимо два знімки, між якими лежить обраний час рендеру.
  #interpolationPair(): InterpolationPair | null {
    const history = this.snapshotHistory;
    if (history.length === 0) return null;
    const earliest = history.at(0);
    const latest = history.at(-1);
    if (!earliest || !latest) return null;
    const targetTime = performance.now() - 50;
    let first = earliest;
    let second = latest;
    for (let index = 1; index < history.length; index += 1) {
      const current = history[index];
      const previous = history[index - 1];
      if (!current || !previous) continue;
      if (current.receivedAt >= targetTime) {
        first = previous;
        second = current;
        break;
      }
      first = current;
    }
    const duration = second.receivedAt - first.receivedAt;
    const alpha = duration > 0 ? Math.max(0, Math.min(1, (targetTime - first.receivedAt) / duration)) : 1;
    if (renderAllocationBaseline) return { first, second, alpha }; // Baseline повторює пару, що створювалась кожного кадру.
    if (!this.#interpolationScratch)
      this.#interpolationScratch = { first, second, alpha }; // Створюємо буфер лише після першого знімка.
    else {
      this.#interpolationScratch.first = first; // Перезаписуємо поточну ліву межу інтерполяції.
      this.#interpolationScratch.second = second; // Перезаписуємо праву межу інтерполяції.
      this.#interpolationScratch.alpha = alpha; // Оновлюємо коефіцієнт без нової пари.
    }
    return this.#interpolationScratch; // Віддаємо незмінний за адресою об'єкт до наступного кадру.
  }

  // Малюємо останній серверний набір куль, який уже прийшов у кімнату.
  #drawServerBullets(ctx: CanvasRenderingContext2D): void {
    const latest = this.snapshotHistory.at(-1)?.snapshot;
    if (!latest) return;
    const localIds = renderAllocationBaseline ? new Set(this.predictedBullets.keys()) : null; // Відтворюємо старий тимчасовий Set лише для baseline.
    for (const bullet of latest.bullets) {
      if (renderAllocationBaseline ? localIds?.has(bullet.id) : this.predictedBullets.has(bullet.id)) continue; // Оптимізований режим читає Map напряму.
      let visualBullet: BulletRenderState = bullet; // Чужий постріл використовує серверний об'єкт напряму.
      if (bullet.ownerId === this.playerId) {
        if (renderAllocationBaseline) {
          visualBullet = {
            ...bullet,
            x: wrapCoordinate(bullet.x + this.correctionX, ARENA_WIDTH),
            y: wrapCoordinate(bullet.y + this.correctionY, ARENA_HEIGHT),
          }; // Baseline копіює підтверджену кулю при кожному рендері.
        } else {
          this.#renderBulletMotion.x = wrapCoordinate(bullet.x + this.correctionX, ARENA_WIDTH); // Оновлюємо локальну корекцію без object spread.
          this.#renderBulletMotion.y = wrapCoordinate(bullet.y + this.correctionY, ARENA_HEIGHT);
          this.#renderBulletMotion.vx = bullet.vx;
          this.#renderBulletMotion.vy = bullet.vy;
          this.#renderBulletMotion.ttl = bullet.ttl;
          visualBullet = this.#renderBulletMotion; // Передаємо той самий scratch у renderer.
        }
      }
      this.#drawBullet(ctx, visualBullet); // Власна підтверджена куля згладжується разом із кораблем.
    }
  }

  // Малюємо власний корабель одразу після локального input.
  #drawPredictedShip(ctx: CanvasRenderingContext2D): void {
    if (!this.localState || !this.playerId || this.localState.hp <= 0) return;
    const visualState = renderAllocationBaseline
      ? integrate(this.localState, this.renderInput, this.accumulator)
      : integrateInto(this.localState, this.renderInput, this.accumulator, this.#renderShipMotion); // Оптимізований preview пише в стабільний об'єкт.
    const x = wrapCoordinate(visualState.x + this.correctionX, ARENA_WIDTH);
    const y = wrapCoordinate(visualState.y + this.correctionY, ARENA_HEIGHT);
    let name = 'Я';
    const players = this.snapshotHistory.at(-1)?.snapshot.players;
    if (renderAllocationBaseline) {
      name = players?.find((player) => player.id === this.playerId)?.name ?? 'Я'; // Baseline залишає попередній callback-пошук і його масиви.
    } else if (players) {
      for (const player of players) {
        if (player.id === this.playerId) {
          name = player.name;
          break;
        }
      }
    }
    this.#drawShip(ctx, x, y, visualState.angle + this.correctionAngle, name, this.localState.hp, this.thrusting);
  }

  // Показуємо власні кулі ще до відповіді сервера.
  #drawPredictedBullets(ctx: CanvasRenderingContext2D): void {
    for (const bullet of this.predictedBullets.values()) {
      if (renderAllocationBaseline) {
        const visualBullet = integrateBullet(bullet, this.accumulator); // Baseline створює новий стан для кожної прогнозованої кулі.
        if (visualBullet.dead) continue;
        this.#drawBullet(ctx, {
          ...visualBullet,
          x: wrapCoordinate(visualBullet.x + this.correctionX, ARENA_WIDTH),
          y: wrapCoordinate(visualBullet.y + this.correctionY, ARENA_HEIGHT),
        }); // Старий шлях копіює об'єкт і накладає згладжування.
        continue;
      }
      const visualBullet = integrateBulletInto(bullet, this.accumulator, this.#renderBulletMotion); // Інтегруємо постріл у повторно використану пам'ять.
      if (visualBullet.ttl <= 0) continue; // TTL не впливає на рендер після завершення пострілу.
      visualBullet.x = wrapCoordinate(visualBullet.x + this.correctionX, ARENA_WIDTH); // Коригуємо координати на місці.
      visualBullet.y = wrapCoordinate(visualBullet.y + this.correctionY, ARENA_HEIGHT);
      this.#drawBullet(ctx, visualBullet); // Куля не створює об'єкт на кожному кадрі.
    }
  }

  // Корабель малюється простим трикутником, повернутим носом за кутом фізики.
  #drawShip(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    angle: number,
    name: string,
    hp: number,
    thrusting = false,
  ): void {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle + Math.PI / 2); // Спрайт корабля в asset-файлі спрямований угору.
    const image = sprites.hero;
    if (image) {
      const frame = fullSpriteFrame(image); // Source rectangle кешується між кораблями й кадрами.
      if (renderAllocationBaseline)
        drawSprite(ctx, image, 0, 0, 45, 45, 0, frame); // Baseline повторює початкове вкладене перетворення.
      else ctx.drawImage(image, frame.x, frame.y, frame.w, frame.h, -22.5, -22.5, 45, 45); // Контекст уже повернутий, тому не дублюємо save/translate/rotate.
    } else {
      ctx.beginPath();
      ctx.moveTo(20, 0);
      ctx.lineTo(-15, -13);
      ctx.lineTo(-10, 0);
      ctx.lineTo(-15, 13);
      ctx.closePath();
      ctx.strokeStyle = '#66fcf1';
      ctx.stroke();
    } // Повертаємо той самий запасний корабель, якщо спрайт відсутній.
    if (thrusting) {
      ctx.beginPath();
      ctx.moveTo(-15, -4);
      ctx.lineTo(-27, 0);
      ctx.lineTo(-15, 4);
      ctx.strokeStyle = '#ff8c42';
      ctx.stroke();
    } // Полум'я показує тягу власного та інших кораблів.
    ctx.restore();
    ctx.fillStyle = '#ffffff';
    ctx.font = '13px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(name + ' · HP ' + hp, x, y + 30);
  }

  // Куля має той самий колір і масштаб незалежно від протоколу.
  #drawBullet(ctx: CanvasRenderingContext2D, bullet: BulletRenderState): void {
    const image = sprites.bullets;
    if (image) {
      const frame = Math.floor((1.2 - bullet.ttl) * 12) % 4;
      const angle = Math.atan2(bullet.vy, bullet.vx);
      drawSprite(ctx, image, bullet.x, bullet.y, 16, 16, angle, bulletSpriteFrames[frame] ?? null);
    } else {
      ctx.beginPath();
      ctx.arc(bullet.x, bullet.y, 4, 0, Math.PI * 2);
      ctx.fillStyle = '#ffe66d';
      ctx.fill();
    } // Відновлюємо текстуровану кулю та лишаємо видимий запасний варіант.
  }

  // Додаємо локальні частинки у відповідь на підтверджене сервером знищення.
  #spawnExplosion(x: number, y: number, count = 15): void {
    for (let index = 0; index < count; index += 1) {
      const angle = (index / count) * Math.PI * 2;
      const speed = 35 + ((index * 29) % 70);
      const effect = this.effectPool.pop() ?? { x: 0, y: 0, vx: 0, vy: 0, ttl: 0 }; // Беремо частинку з пулу або створюємо її один раз.
      effect.x = x; // Перезаписуємо позицію повторно використаного ефекту.
      effect.y = y; // Перезаписуємо вертикальну позицію.
      effect.vx = Math.cos(angle) * speed; // Задаємо напрямок руху.
      effect.vy = Math.sin(angle) * speed; // Задаємо вертикальну швидкість.
      effect.ttl = 0.55; // Повертаємо початковий час життя.
      this.effects.push(effect); // Додаємо підготовлений об'єкт у список малювання.
    }
  }

  // Рухаємо й прибираємо декоративні частинки без map/filter алокацій на кожному кадрі.
  #stepEffects(dt: number): void {
    let index = 0; // Обходимо той самий масив, поки переміщуємо частинки.
    while (index < this.effects.length) {
      const effect = this.effects[index]; // Читаємо поточний ефект без створення копії.
      if (!effect) {
        index += 1; // Захищаємо noUncheckedIndexedAccess від відсутнього слота.
        continue; // Продовжуємо обхід чинного масиву.
      } // Завершуємо перевірку слота.
      effect.x = wrapCoordinate(effect.x + effect.vx * dt, ARENA_WIDTH); // Оновлюємо координату на місці.
      effect.y = wrapCoordinate(effect.y + effect.vy * dt, ARENA_HEIGHT); // Оновлюємо вертикальну координату на місці.
      effect.ttl -= dt; // Відлічуємо час життя в фіксованому кроці.
      if (effect.ttl > 0) {
        index += 1; // Активна частинка лишається у тому самому індексі.
        continue; // Переходимо до наступної частинки.
      } // Завершуємо перевірку тривалості ефекту.
      const last = this.effects.pop(); // Забираємо останню комірку без зсуву всього масиву.
      if (last && last !== effect) this.effects[index] = last; // Переставляємо останню активну частинку на місце завершеної.
      if (this.effectPool.length < 512) this.effectPool.push(effect); // Повертаємо об'єкт до обмеженого пулу.
    } // Завершуємо оновлення всіх ефектів без додаткового масиву.
  }

  // Повертаємо всі активні частинки до пулу перед новою мережевою сесією.
  #clearEffects(): void {
    for (const effect of this.effects) if (this.effectPool.length < 512) this.effectPool.push(effect); // Зберігаємо об'єкти в обмеженому сховищі.
    this.effects.length = 0; // Очищаємо активний список без заміни його масиву.
  } // Завершуємо очищення мережевих ефектів.

  // Малюємо частинки вибухів поверх текстурованих сутностей.
  #drawEffects(ctx: CanvasRenderingContext2D): void {
    for (const effect of this.effects) {
      ctx.globalAlpha = Math.min(1, effect.ttl / 0.55);
      ctx.fillStyle = '#ff8c42';
      ctx.fillRect(effect.x, effect.y, 3, 3);
    }
    ctx.globalAlpha = 1;
  }
}
