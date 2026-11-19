// Room зберігає гравців і надсилає EventEmitter-події для журналу та зміни учасників.
import { randomInt, randomUUID } from 'node:crypto'; // Сервер створює ID та стартовий seed матчу.
import { EventEmitter } from 'node:events'; // Події Room відокремлюють membership від журналу й HTTP.
import type { WebSocket } from 'ws';
import { Bot, type PlayerInput } from './bots.js'; // Серверний AI повертає ті самі команди, що й живий гравець.
import { performance } from 'node:perf_hooks'; // Монотонний годинник планує серверні кроки.
import { config } from './config.js'; // Перевірені ліміти задають кількість кімнат і гравців.
import { createMatchLogger } from './logger.js'; // Кожна кімната пише власний потік NDJSON.
import { recordTraffic } from './appMetrics.js'; // Рахуємо вихідні байти, не записуючи вміст чату чи стану.
import {
  ARENA_HEIGHT,
  ARENA_WIDTH,
  FIXED_DT,
  SHIP_CONFIG,
  SIMULATION_HZ,
  createAsteroidState,
  createBullet,
  createPickupState,
  createShipState,
  integrateAsteroid,
  integrate,
  integrateBullet,
  nextRandom,
  wrappedDelta,
} from '../../shared/engine.js'; // Сервер і клієнт використовують однакові правила руху.
import { serializeSnapshot } from '../../shared/protocol.js'; // Бінарні знімки кодуються спільним DataView-протоколом.
import {
  asEntityId,
  asSeq,
  asTick,
  type AsteroidEntity,
  type BulletEntity,
  type EntityId,
  type InputCommand,
  type PickupEntity,
  type Seq,
  type ShipEntity,
  type ShipState,
  type Snapshot,
} from '../../shared/types.js'; // Межі сервера брендують ID та послідовності.

export interface RoomPlayer {
  readonly id: EntityId;
  readonly name: string;
  readonly format: 'binary' | 'json';
  readonly bot: boolean;
  state: MutableShipState;
  readonly inputQueue: InputCommand[];
  currentInput: InputCommand;
  lastQueuedSeq: Seq;
  lastShotSeq: Seq;
  fireCooldown: number;
  collisionCooldown: number;
}
type MutableShipState = { -readonly [Key in keyof ShipState]: ShipState[Key] };

interface RoomEvents {
  join: [player: RoomPlayer];
  leave: [player: RoomPlayer];
  chat: [
    message: {
      readonly v: 1;
      readonly type: 'chat';
      readonly sender: string;
      readonly text: string;
      readonly at: string;
    },
  ];
  empty: [roomId: EntityId];
}

export interface Room {
  id: EntityId;
  name: string;
  clients: Map<WebSocket, RoomPlayer>;
  players: Map<EntityId, RoomPlayer>;
  maxPlayers: number;
  log: ReturnType<typeof createMatchLogger>;
  everJoined: boolean;
  closed: boolean;
  seed: number;
  rngSeed: number;
  nextAsteroidId: number;
  nextPickupId: number;
  asteroids: AsteroidEntity[];
  pickups: Map<EntityId, PickupEntity>;
  asteroidRespawns: number[];
  tickNumber: number;
  stepDurations: Float32Array;
  stepSampleCount: number;
  stepSampleCursor: number;
  lastStepDurationMs: number;
  maxStepDurationMs: number;
  tickTimer: ReturnType<typeof setTimeout> | null;
  nextTickAt: number;
  lastSnapshotAt: number;
  bullets: Map<EntityId, BulletEntity>;
  addBots(count: number): number;
  getStepDurationSamples(): number[];
}

export interface RoomManager {
  readonly rooms: Map<EntityId, Room>;
  readonly maxRooms: number;
  closing: boolean;
  getStepDurations(): number[];
  addBots(roomId: string, count: number): number;
}

// Порівнюємо послідовності з урахуванням можливого переходу через 2^32.
function isNewerSequence(candidate: Seq, previous: Seq): boolean {
  const difference = (candidate - previous) >>> 0;
  return difference > 0 && difference < 0x80000000;
}

// Перевіряємо, чи відрізок руху перетинає коло навколо початку координат.
function segmentHitsCircle(startX: number, startY: number, moveX: number, moveY: number, radius: number): boolean {
  const lengthSquared = moveX * moveX + moveY * moveY;
  const projection = lengthSquared === 0 ? 0 : -(startX * moveX + startY * moveY) / lengthSquared;
  const amount = Math.max(0, Math.min(1, projection));
  const closestX = startX + moveX * amount;
  const closestY = startY + moveY * amount;
  return closestX * closestX + closestY * closestY <= radius * radius;
}

export class Room extends EventEmitter<RoomEvents> {
  #botInputs = new Map<EntityId, PlayerInput>(); // Кожний бот має окрему стратегію керування.
  stepDurations: Float32Array; // Фіксований кільцевий буфер не створює масив на кожному кроці.
  stepSampleCount: number; // Кількість дійсних значень у кільцевому буфері.
  stepSampleCursor: number; // Наступне місце запису в буфері.
  lastStepDurationMs: number; // Останній час серверного stepSimulation.
  maxStepDurationMs: number; // Найбільший замір цього матчу.

  // Створюємо порожню кімнату та її журнал матчу.
  constructor(id: EntityId, name: string) {
    super(); // Спершу ініціалізуємо EventEmitter, а тоді реєструємо слухачі.
    this.id = id; // Зберігаємо ID кімнати для протоколу лобі.
    this.name = name; // Зберігаємо назву, яку бачить гравець.
    this.clients = new Map(); // Зіставляємо сокет із записом його гравця.
    this.players = new Map(); // Зберігаємо ті самі записи за ID гравця.
    this.maxPlayers = config.MAX_PLAYERS_PER_ROOM; // Застосовуємо задану місткість кімнати.
    this.log = createMatchLogger(id); // Запускаємо pipeline Transform до файла для цієї кімнати.
    this.everJoined = false; // Відрізняємо щойно створену кімнату від спорожнілої після матчу.
    this.closed = false; // Не дозволяємо повторно закрити потік журналу.
    this.seed = randomInt(1, 0xffffffff); // Seed створює сервер і передає гравцям для відтворюваної симуляції.
    this.rngSeed = this.seed; // Робочий стан генератора зберігається окремо від початкового seed.
    this.nextAsteroidId = 1; // Новий астероїд отримує окремий ID для клієнтського рендеру.
    this.nextPickupId = 1; // ID аптечки потрібен для синхронізації між клієнтами.
    this.asteroids = Array.from({ length: 5 }, () => this.#createAsteroid()); // Сервер створює п'ять перешкод із власного seed.
    this.pickups = new Map(); // Сервер зберігає бонуси та передає їх у кожному знімку.
    this.asteroidRespawns = []; // Таймери повертають знищені астероїди у світ.
    this.tickNumber = 0; // Номер кроку замінює залежність симуляції від настінного часу.
    this.stepDurations = new Float32Array(512); // Зберігаємо останні 512 замірів без виділення об'єктів.
    this.stepSampleCount = 0; // Буфер спочатку не містить вимірювань.
    this.stepSampleCursor = 0; // Перший замір починається з нульової комірки.
    this.lastStepDurationMs = 0; // До першого кроку час дорівнює нулю.
    this.maxStepDurationMs = 0; // Максимум починається з нуля.
    this.tickTimer = null; // Один timeout планує наступний крок без setInterval.
    this.nextTickAt = 0; // Цільовий час наступного кроку за монотонним годинником.
    this.lastSnapshotAt = 0; // Обмежуємо розсилання під час наздоганяння до 30 знімків за секунду.
    this.bullets = new Map(); // Сервер зберігає всі активні кулі матчу.
  } // Завершуємо створення кімнати.

  // Додаємо гравця, записуємо подію та надсилаємо оновлений список учасників.
  async addClient(
    socket: WebSocket,
    username: string,
    format: 'binary' | 'json' = 'binary',
  ): Promise<RoomPlayer | null> {
    if (this.clients.size >= this.maxPlayers) return null; // Відхиляємо вхід, якщо кімната вже заповнена.
    const player = {
      id: asEntityId(randomUUID()),
      name: username,
      format,
      bot: false,
      state: this.#createSpawnState(),
      inputQueue: [],
      currentInput: { seq: asSeq(0), gas: false, turn: 0, shoot: false } satisfies InputCommand,
      lastQueuedSeq: asSeq(0),
      lastShotSeq: asSeq(0),
      fireCooldown: 0,
      collisionCooldown: 0,
    }; // Гравець отримує стан і чергу вводу, які контролює тільки сервер.
    this.clients.set(socket, player); // Пов'язуємо мережеве з'єднання з гравцем.
    this.players.set(player.id, player); // Тримаємо список за ID для формування roster.
    this.everJoined = true; // Видалимо кімнату, коли останній учасник вийде.
    try {
      await this.log.log('join', { roomId: this.id, playerId: player.id, name: player.name });
    } catch (error) {
      this.clients.delete(socket);
      this.players.delete(player.id);
      throw error;
    } // Відкочуємо membership, якщо запис журналу завершився помилкою.
    this.emit('join', player); // Повідомляємо підписників про вхід гравця.
    this.broadcastRoster(); // Розсилаємо оновлений список усім з'єднанням.
    return player; // Повертаємо серверний запис гравця у wsServer.
  } // Завершуємо вхід до кімнати.

  // Додаємо перевірену команду до черги саме того гравця, якому належить сокет.
  // Додаємо AI-пілотів, які керують кораблями через звичайні команди input.
  addBots(count: number): number {
    const available = Math.max(0, this.maxPlayers - this.players.size); // Не перевищуємо місткість кімнати.
    const amount = Math.min(count, available); // Створюємо лише стільки ботів, скільки є вільних місць.
    for (let index = 0; index < amount; index += 1) {
      const id = asEntityId(randomUUID()); // Генеруємо звичайний серверний id сутності.
      const player: RoomPlayer = {
        id,
        name: 'Bot ' + (this.#botInputs.size + 1),
        format: 'binary',
        bot: true,
        state: this.#createSpawnState(),
        inputQueue: [],
        currentInput: { seq: asSeq(0), gas: false, turn: 0, shoot: false },
        lastQueuedSeq: asSeq(0),
        lastShotSeq: asSeq(0),
        fireCooldown: 0,
        collisionCooldown: 0,
      }; // Бот має ту саму форму сутності, що й мережевий гравець.
      this.players.set(id, player); // Спільний цикл оновлює його як звичайний корабель.
      this.#botInputs.set(id, new Bot()); // Вибір input ізольовано окремою AI-стратегією.
      this.emit('join', player); // Повідомляємо кімнату про нового учасника.
    } // Завершуємо створення запитаних ботів.
    if (amount > 0) {
      this.everJoined = true; // Кімната з ботами вважається запущеною.
      this.broadcastRoster(); // Клієнти отримають ботів у звичайному списку гравців.
      this.startSimulation(); // Запускаємо 30 Hz симуляцію для активної кімнати.
    } // Не змінюємо стан кімнати, якщо вільних місць немає.
    return amount; // Повертаємо фактичне число створених ботів.
  } // Завершуємо створення AI пілотів.

  queueInput(socket: WebSocket, input: InputCommand): boolean {
    const player = this.clients.get(socket);
    if (!player || !isNewerSequence(input.seq, player.lastQueuedSeq)) return false;
    player.lastQueuedSeq = input.seq;
    const lastPendingInput = player.inputQueue.at(-1); // Перевіряємо лише останній ще не оброблений стан клавіш.
    if (
      lastPendingInput &&
      !lastPendingInput.shoot &&
      !input.shoot &&
      lastPendingInput.gas === input.gas &&
      lastPendingInput.turn === input.turn
    ) {
      player.inputQueue[player.inputQueue.length - 1] = input; // Однаковий рух згортаємо до найновішої послідовності.
      return true; // Сервер усе одно безперервно інтегрує попередній рух на кожному кроці.
    } // Постріли не згортаються, бо це одноразова подія, а не стан клавіші.
    if (player.inputQueue.length >= 120) player.inputQueue.shift();
    player.inputQueue.push(input);
    return true;
  }

  // Повертаємо початковий стан гравця для відповіді joined_success.
  getPlayerState(playerId: EntityId): (ShipEntity & { readonly name: string }) | null {
    const player = this.players.get(playerId);
    if (!player) return null;
    return { id: player.id, name: player.name, ...player.state };
  }

  // Повертаємо початковий знімок, щоб клієнт одразу побачив кораблі й астероїди.
  getSnapshot(): Snapshot {
    return this.#createSnapshot();
  }

  // Запускаємо один рекурсивний timeout, коли до кімнати приєднався перший гравець.
  startSimulation(): void {
    if (this.tickTimer || this.clients.size === 0 || this.closed) return;
    this.nextTickAt = performance.now() + 1000 / SIMULATION_HZ;
    this.#scheduleNextTick();
  }

  // Плануємо кожен крок на цільовий час, а не через setInterval.
  #scheduleNextTick(): void {
    if (this.clients.size === 0 || this.closed) return;
    const interval = 1000 / SIMULATION_HZ;
    const delay = Math.max(0, this.nextTickAt - performance.now());
    this.tickTimer = setTimeout(() => {
      this.tickTimer = null;
      const now = performance.now();
      let steps = 0;
      while (this.nextTickAt <= now && steps < 5) {
        const stepStartedAt = performance.now(); // Вимірюємо лише обчислення одного кроку симуляції.
        this.#stepSimulation(false);
        const duration = performance.now() - stepStartedAt; // Зчитуємо тривалість до серіалізації snapshot.
        this.lastStepDurationMs = duration; // Зберігаємо останній крок для діагностики.
        this.maxStepDurationMs = Math.max(this.maxStepDurationMs, duration); // Оновлюємо максимум матчу.
        this.stepDurations[this.stepSampleCursor] = duration; // Перезаписуємо комірку кільцевого буфера.
        this.stepSampleCursor = (this.stepSampleCursor + 1) % this.stepDurations.length; // Переміщуємо індекс без алокації.
        this.stepSampleCount = Math.min(this.stepSampleCount + 1, this.stepDurations.length); // Обмежуємо вікно останніми 512 кроками.
        this.nextTickAt += interval;
        steps += 1;
      }
      const snapshotNow = performance.now();
      if (steps > 0 && (this.lastSnapshotAt === 0 || snapshotNow - this.lastSnapshotAt >= interval)) {
        this.#broadcastSnapshot();
        this.lastSnapshotAt = snapshotNow;
      }
      this.#scheduleNextTick();
    }, delay);
    this.tickTimer.unref();
  }

  // Копіюємо кільцевий буфер лише за окремим HTTP-запитом діагностики.
  getStepDurationSamples(): number[] {
    const samples = new Array<number>(this.stepSampleCount); // Виділяємо масив поза гарячим циклом сервера.
    const first =
      (this.stepSampleCursor - this.stepSampleCount + this.stepDurations.length) % this.stepDurations.length; // Знаходимо найстаріший запис.
    for (let index = 0; index < this.stepSampleCount; index += 1) {
      const ringIndex = (first + index) % this.stepDurations.length; // Переходимо через кінець кільцевого буфера.
      samples[index] = this.stepDurations[ringIndex] ?? 0; // Повертаємо збережений час.
    } // Завершуємо копіювання короткого вікна.
    return samples; // Віддаємо копію для вимірювального скрипту.
  } // Завершуємо читання вимірів серверного кроку.

  // Просуваємо всю кімнату на один фіксований крок у 1/30 секунди.
  #updateBotInputs(): void {
    const states = [...this.players.values()].map((player) => player.state); // Створюємо один компактний список кораблів на весь крок.
    for (const [id, inputSource] of this.#botInputs) {
      const player = this.players.get(id); // Знаходимо стан відповідного бота.
      if (!player) continue; // Пропускаємо видалений корабель.
      const nextSequence = asSeq((player.currentInput.seq + 1) >>> 0); // Послідовність бота лишається uint32, як у клієнта.
      player.currentInput = inputSource.next(player.state, states, this.asteroids, nextSequence); // AI повертає input, а не координати.
    } // Завершуємо підготовку команд усіх ботів.
  } // Завершуємо генерацію server-side input.

  #stepSimulation(broadcast = true): void {
    this.tickNumber += 1;
    this.#updateBotInputs(); // Боти й люди передають команди в ту саму фізику.
    const previousPlayers = new Map([...this.players.values()].map((player) => [player.id, player.state]));
    const previousAsteroids = new Map(this.asteroids.map((asteroid) => [asteroid.id, asteroid]));
    for (const player of this.players.values()) {
      const nextInput = player.inputQueue.shift();
      if (nextInput) player.currentInput = nextInput;
      player.state.ackSeq = player.currentInput.seq;

      if (player.state.hp <= 0) {
        player.state.respawnTicks = Math.max(0, player.state.respawnTicks - 1);
        if (player.state.respawnTicks === 0) {
          const ackSeq = player.state.ackSeq;
          const score = player.state.score;
          player.state = this.#createSpawnState();
          player.state.ackSeq = ackSeq;
          player.state.score = score; // Рахунок лишається тим самим після респауну корабля.
        }
        player.fireCooldown = Math.max(0, player.fireCooldown - FIXED_DT);
        continue;
      }

      player.state = integrate(player.state, player.currentInput, FIXED_DT);
      player.state.ackSeq = player.currentInput.seq;
      player.fireCooldown = Math.max(0, player.fireCooldown - FIXED_DT);
      if (player.currentInput.shoot && player.currentInput.seq !== player.lastShotSeq && player.fireCooldown === 0) {
        const bullet = createBullet(player.state, player.id, player.currentInput.seq);
        this.bullets.set(bullet.id, bullet);
        player.lastShotSeq = player.currentInput.seq;
        player.fireCooldown = SHIP_CONFIG.fireCooldown;
      }
    }

    this.#stepAsteroids();
    this.#resolveAsteroidCollisions(previousPlayers, previousAsteroids);
    this.#stepBullets(previousAsteroids);
    if (broadcast) this.#broadcastSnapshot();
  }

  // Пересуваємо астероїди та відлічуємо фіксовані кроки до їхнього респауну.
  #stepAsteroids(): void {
    this.asteroids = this.asteroids.map((asteroid) => {
      if (!asteroid.homing) return integrateAsteroid(asteroid, FIXED_DT);
      const target = [...this.players.values()].find((player) => player.state.hp > 0);
      if (!target) return integrateAsteroid(asteroid, FIXED_DT);
      const dx = wrappedDelta(asteroid.x, target.state.x, ARENA_WIDTH);
      const dy = wrappedDelta(asteroid.y, target.state.y, ARENA_HEIGHT);
      const desiredAngle = Math.atan2(dy, dx);
      const currentAngle = Math.atan2(asteroid.vy, asteroid.vx);
      const difference = Math.atan2(Math.sin(desiredAngle - currentAngle), Math.cos(desiredAngle - currentAngle));
      const turn = Math.max(-1.2 * FIXED_DT, Math.min(1.2 * FIXED_DT, difference));
      const speed = Math.hypot(asteroid.vx, asteroid.vy);
      const heading = currentAngle + turn;
      return integrateAsteroid({ ...asteroid, vx: Math.cos(heading) * speed, vy: Math.sin(heading) * speed }, FIXED_DT);
    });
    const waiting = [];
    for (const ticksLeft of this.asteroidRespawns) {
      if (ticksLeft <= 1) this.asteroids.push(this.#createAsteroid());
      else waiting.push(ticksLeft - 1);
    }
    this.asteroidRespawns = waiting;
  }

  // Пошкоджуємо корабель при зіткненні, але даємо час вийти з контакту.
  #resolveAsteroidCollisions(
    previousPlayers: Map<EntityId, ShipState>,
    previousAsteroids: Map<EntityId, AsteroidEntity>,
  ): void {
    for (const player of this.players.values()) {
      player.collisionCooldown = Math.max(0, player.collisionCooldown - FIXED_DT);
      if (player.state.hp <= 0) continue;
      for (const [pickupId, pickup] of this.pickups) {
        const dx = wrappedDelta(player.state.x, pickup.x, ARENA_WIDTH);
        const dy = wrappedDelta(player.state.y, pickup.y, ARENA_HEIGHT);
        const distance = pickup.radius + 15;
        if (dx * dx + dy * dy > distance * distance) continue;
        player.state.hp = Math.min(255, player.state.hp + 1);
        this.pickups.delete(pickupId);
        break;
      }
      if (player.collisionCooldown > 0) continue;
      const previousPlayer = previousPlayers.get(player.id);
      if (!previousPlayer || previousPlayer.hp <= 0) continue;
      const playerMoveX = wrappedDelta(previousPlayer.x, player.state.x, ARENA_WIDTH);
      const playerMoveY = wrappedDelta(previousPlayer.y, player.state.y, ARENA_HEIGHT);
      for (let index = 0; index < this.asteroids.length; index += 1) {
        const asteroid = this.asteroids[index];
        if (!asteroid) continue;
        const previousAsteroid = previousAsteroids.get(asteroid.id) ?? asteroid;
        const asteroidMoveX = wrappedDelta(previousAsteroid.x, asteroid.x, ARENA_WIDTH);
        const asteroidMoveY = wrappedDelta(previousAsteroid.y, asteroid.y, ARENA_HEIGHT);
        const startX = wrappedDelta(previousAsteroid.x, previousPlayer.x, ARENA_WIDTH);
        const startY = wrappedDelta(previousAsteroid.y, previousPlayer.y, ARENA_HEIGHT);
        if (
          !segmentHitsCircle(
            startX,
            startY,
            playerMoveX - asteroidMoveX,
            playerMoveY - asteroidMoveY,
            asteroid.radius + 15,
          )
        ) {
          continue;
        }
        this.asteroids.splice(index, 1);
        this.asteroidRespawns.push(SIMULATION_HZ * 3);
        player.state.hp = Math.max(0, player.state.hp - 1);
        player.collisionCooldown = 0.65;
        if (player.state.hp === 0) player.state.respawnTicks = SIMULATION_HZ * 2;
        break;
      }
    }
  }

  // Рухаємо кулі серверною фізикою та перевіряємо влучання в астероїди й кораблі.
  #stepBullets(previousAsteroids: Map<EntityId, AsteroidEntity>): void {
    for (const [bulletId, oldBullet] of this.bullets) {
      const bullet = integrateBullet(oldBullet, FIXED_DT);
      if (bullet.dead) {
        this.bullets.delete(bulletId);
        continue;
      }
      this.bullets.set(bulletId, bullet);

      const asteroidIndex = this.asteroids.findIndex((asteroid) => {
        const previous = previousAsteroids.get(asteroid.id) ?? asteroid;
        const bulletMoveX = wrappedDelta(oldBullet.x, bullet.x, ARENA_WIDTH);
        const bulletMoveY = wrappedDelta(oldBullet.y, bullet.y, ARENA_HEIGHT);
        const asteroidMoveX = wrappedDelta(previous.x, asteroid.x, ARENA_WIDTH);
        const asteroidMoveY = wrappedDelta(previous.y, asteroid.y, ARENA_HEIGHT);
        const startX = wrappedDelta(previous.x, oldBullet.x, ARENA_WIDTH);
        const startY = wrappedDelta(previous.y, oldBullet.y, ARENA_HEIGHT);
        return segmentHitsCircle(
          startX,
          startY,
          bulletMoveX - asteroidMoveX,
          bulletMoveY - asteroidMoveY,
          asteroid.radius + 8,
        );
      });
      if (asteroidIndex >= 0) {
        this.bullets.delete(bulletId);
        const [asteroid] = this.asteroids.splice(asteroidIndex, 1);
        if (!asteroid) continue;
        this.asteroidRespawns.push(SIMULATION_HZ * 3);
        if (this.#randomValue() < 0.2) {
          const pickup = this.#createPickup(asteroid.x, asteroid.y);
          this.pickups.set(pickup.id, pickup);
        }
        const shooter = this.players.get(bullet.ownerId);
        if (shooter) shooter.state.score = (shooter.state.score + 10) & 0xffff;
        continue;
      }

      for (const target of this.players.values()) {
        if (target.id === bullet.ownerId || target.state.hp <= 0) continue;
        const dx = wrappedDelta(bullet.x, target.state.x, ARENA_WIDTH);
        const dy = wrappedDelta(bullet.y, target.state.y, ARENA_HEIGHT);
        if (dx * dx + dy * dy > 24 * 24) continue;

        this.bullets.delete(bulletId);
        target.state.hp = Math.max(0, target.state.hp - 1);
        if (target.state.hp === 0) {
          target.state.respawnTicks = SIMULATION_HZ * 2;
          const shooter = this.players.get(bullet.ownerId);
          if (shooter) shooter.state.score = (shooter.state.score + 1) & 0xffff;
        }
        break;
      }
    }
  }

  // Беремо наступне число тільки із серверного генератора псевдовипадкових чисел.
  #randomValue(): number {
    const next = nextRandom(this.rngSeed);
    this.rngSeed = next.seed;
    return next.value;
  }

  // Створюємо серверний астероїд із позицією та швидкістю, залежними від seed.
  #createAsteroid(): AsteroidEntity {
    const radius = 20 + this.#randomValue() * 12;
    const x = radius + this.#randomValue() * (ARENA_WIDTH - radius * 2);
    const y = radius + this.#randomValue() * (ARENA_HEIGHT - radius * 2);
    const angle = this.#randomValue() * Math.PI * 2;
    const speed = 24 + this.#randomValue() * 36;
    return createAsteroidState(
      asEntityId('asteroid-' + this.nextAsteroidId++),
      x,
      y,
      Math.cos(angle) * speed,
      Math.sin(angle) * speed,
      radius,
      this.#randomValue() < 0.2,
    );
  }

  // Створюємо аптечку з координатами підтвердженого сервером вибуху.
  #createPickup(x: number, y: number): PickupEntity {
    return createPickupState(asEntityId('pickup-' + this.nextPickupId++), x, y);
  }

  // Вибираємо стартову позицію корабля осторонь від каміння та інших пілотів.
  #createSpawnState(): MutableShipState {
    let state: MutableShipState = { ...createShipState(ARENA_WIDTH / 2, ARENA_HEIGHT / 2) };
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const x = 80 + this.#randomValue() * (ARENA_WIDTH - 160);
      const y = 80 + this.#randomValue() * (ARENA_HEIGHT - 160);
      const angle = (this.#randomValue() * 2 - 1) * Math.PI;
      state = { ...createShipState(x, y, angle) };
      const clearOfAsteroids = this.asteroids.every((asteroid) => {
        const dx = wrappedDelta(x, asteroid.x, ARENA_WIDTH);
        const dy = wrappedDelta(y, asteroid.y, ARENA_HEIGHT);
        return dx * dx + dy * dy > (asteroid.radius + 70) ** 2;
      });
      const clearOfPlayers = [...this.players.values()].every((player) => {
        if (player.state.hp <= 0) return true;
        const dx = wrappedDelta(x, player.state.x, ARENA_WIDTH);
        const dy = wrappedDelta(y, player.state.y, ARENA_HEIGHT);
        return dx * dx + dy * dy > 100 ** 2;
      });
      if (clearOfAsteroids && clearOfPlayers) return state;
    }
    return state;
  }

  // Формуємо один незмінний знімок, який підійде і JSON, і бінарному формату.
  #createSnapshot(): Snapshot {
    const players = [...this.players.values()].map((player) => ({
      id: player.id,
      name: player.name,
      ...player.state,
    }));
    const bullets = [...this.bullets.values()].map(({ id, ownerId, x, y, vx, vy, ttl }): BulletEntity => ({
      kind: 'bullet',
      id,
      ownerId,
      x,
      y,
      vx,
      vy,
      ttl,
    }));
    const asteroids = this.asteroids.map(({ id, x, y, vx, vy, radius, homing }): AsteroidEntity => ({
      kind: 'asteroid',
      id,
      x,
      y,
      vx,
      vy,
      radius,
      homing,
    }));
    const pickups = [...this.pickups.values()].map(({ id, x, y, radius }): PickupEntity => ({
      kind: 'pickup',
      id,
      x,
      y,
      radius,
    }));
    return {
      v: 1,
      type: 'snapshot',
      tick: asTick(this.tickNumber >>> 0),
      seed: this.seed,
      players,
      bullets,
      asteroids,
      pickups,
    };
  }

  // Надсилаємо стан кожному учаснику в обраному під час входу форматі.
  #broadcastSnapshot(): void {
    const snapshot = this.#createSnapshot();
    for (const [socket, player] of this.clients) {
      if (socket.readyState !== 1 || socket.bufferedAmount > 64 * 1024) continue;
      const payload = player.format === 'json' ? JSON.stringify(snapshot) : serializeSnapshot(snapshot);
      socket.send(payload, (error) => {
        if (error) socket.terminate();
      });
      recordTraffic('out', typeof payload === 'string' ? Buffer.byteLength(payload) : payload.byteLength); // Враховуємо знімки в метриках вихідного трафіку.
    }
  }

  // Прибираємо з'єднання та видаляємо кімнату після виходу останнього гравця.
  async removeClient(socket: WebSocket): Promise<void> {
    const player = this.clients.get(socket); // Знаходимо гравця, якому належить цей сокет.
    if (!player) return; // Ігноруємо повторний close event.
    this.clients.delete(socket); // Перестаємо маршрутизувати дані з цього сокета.
    this.players.delete(player.id); // Прибираємо гравця з наступних списків учасників.
    for (const [bulletId, bullet] of this.bullets) {
      if (bullet.ownerId === player.id) this.bullets.delete(bulletId);
    } // Кулі від'єднаного гравця більше не належать активному матчу.
    await this.log.log('leave', { roomId: this.id, playerId: player.id, name: player.name }); // Записуємо вихід до закриття журналу.
    this.emit('leave', player); // Повідомляємо слухачів про зміну membership.
    this.broadcastRoster(); // Показуємо решті гравців, хто залишився.
    if (this.clients.size === 0 && this.everJoined) {
      await this.close();
      this.emit('empty', this.id);
    } // Дописуємо журнал і повідомляємо, що кімната спорожніла.
  } // Завершуємо вихід із кімнати.

  // Розсилаємо список гравців за версійованим протоколом.
  broadcastRoster(): void {
    const players = [...this.players.values()].map((player) => ({ id: player.id, name: player.name })); // Віддаємо лише публічні поля учасників.
    this.broadcast({ v: 1, type: 'roster', roomId: this.id, players }, true); // Зміни roster є важливими службовими повідомленнями.
  } // Завершуємо розсилання roster.

  // Записуємо й надсилаємо повідомлення чату від учасника кімнати.
  async sendChatMessage(socket: WebSocket, text: string): Promise<boolean> {
    const player = this.clients.get(socket); // Сервер бере ім'я відправника з прив'язаного сокета.
    if (!player) return false; // Ігноруємо чат від гравця, який уже вийшов.
    const message: RoomEvents['chat'][0] = {
      v: 1,
      type: 'chat',
      sender: player.name,
      text,
      at: new Date().toISOString(),
    }; // Додаємо перевірені серверні метадані.
    await this.log.log('chat', { roomId: this.id, sender: player.name, text }); // Записуємо чат до його розсилання.
    this.emit('chat', message); // Повідомляємо слухачів кімнати.
    this.broadcast(message); // Доставляємо рядок усім поточним учасникам.
    return true; // Підтверджуємо прийняття повідомлення.
  } // Завершуємо обробку чату.

  // Пропускаємо повільного клієнта для чату й закриваємо його, якщо не вміщуються службові дані.
  broadcast(message: object, critical = false): void {
    const payload = JSON.stringify(message); // Серіалізуємо один текстовий кадр для всіх клієнтів.
    for (const socket of this.clients.keys()) {
      // Перебираємо з'єднання учасників цієї кімнати.
      if (socket.readyState !== 1) continue; // Пропускаємо сокети, які вже закриваються.
      if (socket.bufferedAmount > 64 * 1024) {
        if (critical) socket.close(1013, 'slow client');
        continue;
      } // Відкидаємо звичайні дані або закриваємо повільного одержувача roster.
      socket.send(payload, (error) => {
        if (error) socket.terminate();
      }); // Завершуємо сокет, який не зміг прийняти вихідний кадр.
      recordTraffic('out', Buffer.byteLength(payload)); // Рахуємо фактичний UTF-8 розмір для цього одержувача.
    } // Завершуємо розсилання активним клієнтам.
  } // Завершуємо broadcast.

  // Повертаємо поля кімнати, які показує GET /api/rooms.
  toJSON(): { id: EntityId; name: string; players: number; maxPlayers: number } {
    return { id: this.id, name: this.name, players: this.clients.size, maxPlayers: this.maxPlayers }; // Не розкриваємо сокети або внутрішні Map.
  } // Завершуємо створення формату лобі.

  // Дописуємо журнал подій кімнати рівно один раз.
  async close(): Promise<void> {
    if (this.closed) return; // Повторний виклик не змінює вже закриту кімнату.
    this.closed = true; // Не дозволяємо двом викликам закривати журнал одночасно.
    if (this.tickTimer) clearTimeout(this.tickTimer); // Скасовуємо запланований крок, коли кімната закривається.
    this.tickTimer = null; // Прибираємо посилання на вже скасований timeout.
    await this.log.close(); // Чекаємо, поки pipeline допише й закриє файл.
  } // Завершуємо закриття кімнати.
} // Завершуємо клас кімнати EventEmitter.

export class RoomManager {
  readonly rooms = new Map<EntityId, Room>();
  readonly maxRooms = config.MAX_ROOMS;
  closing = false;
  // Створюємо сховище кімнат та одну початкову кімнату лобі.
  constructor() {
    this.closing = false; // Під час завершення сервера не створюємо кімнату повторно.
    this.create('Кімната 1', 'default_room'); // Додаємо початкову кімнату, до якої можна приєднатися.
  } // Завершуємо створення менеджера.

  // Створюємо кімнату, якщо не досягнуто заданого серверного ліміту.
  create(name: string, id: string = randomUUID()): Room | null {
    if (this.closing || this.rooms.size >= this.maxRooms) return null; // Відхиляємо запит під час shutdown або після ліміту.
    const cleanName = String(name).trim(); // Нормалізуємо назву, яку бачить гравець.
    if (!cleanName || cleanName.length > 40) return null; // Вимагаємо коротке непорожнє ім'я кімнати.
    const room = new Room(asEntityId(id), cleanName); // Створюємо кімнату та її журнал.
    this.rooms.set(room.id, room); // Додаємо кімнату до сховища менеджера.
    room.once('empty', () => this.rooms.delete(room.id)); // Видаляємо кімнату після виходу останнього гравця, як вимагає лаба 4.
    return room; // Повертаємо кімнату API або WebSocket handler.
  } // Завершуємо створення кімнати.

  // Шукаємо кімнату за точним ID або видимою назвою.
  getRoom(idOrName: string): Room | null {
    if (typeof idOrName !== 'string') return null; // Пошук приймає лише рядковий ключ.
    const matchingId = this.rooms.get(asEntityId(idOrName)); // Нормалізуємо рядок до branded ID лише для пошуку.
    if (matchingId) return matchingId; // Спершу пробуємо точний збіг ID.
    for (const room of this.rooms.values()) if (room.name === idOrName) return room; // Дозволяємо ручним клієнтам вказати назву.
    return null; // Відхиляємо невідому кімнату, а не підмінюємо її іншою.
  } // Завершуємо пошук кімнати.

  // Серіалізуємо поточний стан кімнат для лобі.
  list(): Array<{ id: EntityId; name: string; players: number; maxPlayers: number }> {
    if (this.rooms.size === 0 && !this.closing) {
      this.create('Кімната 1', 'default_room'); // Якщо список повністю спорожнів, повертаємо початкову кімнату для наступного матчу.
    }
    return [...this.rooms.values()].map((room) => room.toJSON()); // Повертаємо звичайний масив, сумісний із JSON.
  } // Завершуємо формування списку кімнат.

  // Додаємо серверні AI до кімнати за її ID або назвою.
  addBots(roomId: string, count: number): number {
    const room = this.getRoom(roomId); // Знаходимо кімнату тим самим способом, що й API.
    if (!room) return -1; // Відрізняємо невідому кімнату від кімнати без місць.
    return room.addBots(count); // Делегуємо перевірку місткості самої кімнаті.
  } // Завершуємо додавання ботів через менеджер.

  // Збираємо короткі вікна всіх кімнат для локального load benchmark.
  getStepDurations(): number[] {
    const samples: number[] = []; // Створюємо результат лише на запит /health.
    for (const room of this.rooms.values()) {
      for (const duration of room.getStepDurationSamples()) samples.push(duration); // Додаємо виміри кожної кімнати без розгортання великої кількості аргументів.
    } // Завершуємо обхід кімнат.
    return samples; // Повертаємо час обчислення кожного останнього кроку.
  } // Завершуємо збір вимірів.

  // Дописуємо журнали всіх кімнат під час зупинки процесу.
  async close(): Promise<void> {
    this.closing = true; // Не відновлюємо початкову кімнату під час зупинки процесу.
    await Promise.all([...this.rooms.values()].map((room) => room.close())); // Чекаємо завершення pipeline кожної кімнати.
    this.rooms.clear(); // Очищаємо записи кімнат після надійного збереження логів.
  } // Завершуємо зупинку менеджера.
} // Завершуємо менеджер кімнат.
