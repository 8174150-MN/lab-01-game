// Цей модуль містить однакові правила симуляції для браузера та Node.js.
// Тут немає DOM, таймерів, мережевих викликів або імпортів Node.js.
import {
  asEntityId,
  asSeq,
  type AsteroidEntity,
  type BulletEntity,
  type EntityId,
  type InputCommand,
  type PickupEntity,
  type Seq,
  type ShipState,
} from './types.js'; // Спільні типи не додають runtime-логіки до фізики.

// Розмір арени однаковий у клієнта й сервера.
export const ARENA_WIDTH = 1280;
export const ARENA_HEIGHT = 720;

// Сервер виконує рівно один крок симуляції на кожен такий інтервал.
export const SIMULATION_HZ = 30;
export const FIXED_DT = 1 / SIMULATION_HZ;

// Ці значення фізики не змінюються між клієнтом і сервером.
export const SHIP_CONFIG = Object.freeze({
  turnSpeed: Math.PI,
  acceleration: 420,
  dragPerSecond: 0.985 ** 60,
  maxSpeed: 360,
  bulletSpeed: 500,
  bulletTtl: 1.5,
  fireCooldown: 0.2,
});

// Створюємо початковий стан без випадковості та побічних ефектів.
export function createShipState(x: number, y: number, angle = 0): ShipState {
  return {
    kind: 'ship',
    x,
    y,
    vx: 0,
    vy: 0,
    angle,
    hp: 3,
    score: 0,
    respawnTicks: 0,
    ackSeq: asSeq(0),
  };
}

// Обмежуємо кут інтервалом від -π до π, щоб він поміщався в Int16.
export function normalizeAngle(angle: number): number {
  return Math.atan2(Math.sin(angle), Math.cos(angle));
}

// Перетворюємо позицію на тороїдальній арені: вилетівши з краю, корабель з'являється з іншого.
export function wrapCoordinate(value: number, size: number): number {
  return ((value % size) + size) % size;
}

export interface MutableShipMotion {
  x: number;
  y: number;
  vx: number;
  vy: number;
  angle: number;
} // Рухомі поля можна записати в повторно використаний render scratch.

// Застосовуємо один input у переданий буфер, не створюючи нового об'єкта.
export function integrateInto(
  ship: ShipState,
  input: Pick<InputCommand, 'gas' | 'turn'>,
  dt: number,
  output: MutableShipMotion,
): MutableShipMotion {
  const turn = Math.max(-1, Math.min(1, input.turn));
  const angle = normalizeAngle(ship.angle + turn * SHIP_CONFIG.turnSpeed * dt);
  const gas = Boolean(input.gas);
  let vx = ship.vx + (gas ? Math.cos(angle) * SHIP_CONFIG.acceleration * dt : 0);
  let vy = ship.vy + (gas ? Math.sin(angle) * SHIP_CONFIG.acceleration * dt : 0);
  const drag = SHIP_CONFIG.dragPerSecond ** dt;
  vx *= drag;
  vy *= drag;
  const positionVx = vx;
  const positionVy = vy;
  const speed = Math.hypot(vx, vy);
  const scale = speed > SHIP_CONFIG.maxSpeed ? SHIP_CONFIG.maxSpeed / speed : 1;
  vx *= scale;
  vy *= scale;

  output.x = wrapCoordinate(ship.x + positionVx * dt, ARENA_WIDTH); // Записуємо нову позицію у вихідний буфер.
  output.y = wrapCoordinate(ship.y + positionVy * dt, ARENA_HEIGHT); // Не змінюємо вхідний стан корабля.
  output.vx = vx; // Записуємо швидкість після drag і обмеження.
  output.vy = vy; // Обидва середовища використовують те саме обчислення.
  output.angle = angle; // Кут так само нормалізований для сервера і клієнта.
  return output; // Повертаємо той самий буфер для зручності виклику.
} // Завершуємо інтегрування в повторно використаний стан.

// Застосовуємо один input і повертаємо новий стан корабля.
// Функція чиста: вона не змінює ані ship, ані input.
export function integrate(ship: ShipState, input: Pick<InputCommand, 'gas' | 'turn'>, dt = FIXED_DT): ShipState {
  const next: { -readonly [Key in keyof ShipState]: ShipState[Key] } = { ...ship }; // Зберігаємо окремий результат для звичайної фізики.
  integrateInto(ship, input, dt, next); // Використовуємо той самий розрахунок, що й рендер scratch.
  return next; // Повертаємо новий об'єкт, не мутуючи корабель.
}

// Порівнюємо послідовності з урахуванням переповнення uint32.
export function isInputAcknowledged(sequence: Seq, ackSeq: Seq): boolean {
  return (ackSeq - sequence) >>> 0 < 0x80000000;
}

// Відновлюємо передбачення лише з серверного стану та ще не підтверджених команд.
export function reconcilePrediction(authoritativeState: ShipState, inputHistory: readonly InputCommand[]): ShipState {
  let state: ShipState = { ...authoritativeState }; // Копія гарантує, що вхідний серверний кадр лишиться незмінним.
  for (const input of inputHistory) {
    if (isInputAcknowledged(input.seq, authoritativeState.ackSeq)) continue; // Підтверджені команди сервер уже застосував.
    state = integrate(state, input, FIXED_DT); // Повторюємо решту в тому самому фіксованому порядку.
  }
  return state;
}

// Створюємо кулю з передбачуваним ID, щоб клієнт міг зіставити її зі знімком сервера.
export function createBullet(ship: ShipState, ownerId: EntityId, seq: Seq): BulletEntity {
  const directionX = Math.cos(ship.angle);
  const directionY = Math.sin(ship.angle);
  return {
    kind: 'bullet',
    id: asEntityId(ownerId + ':' + (seq >>> 0)), // Складаємо ID кулі з ID стрільця та вже перевіреної послідовності.
    ownerId,
    seq: asSeq(seq >>> 0),
    x: wrapCoordinate(ship.x + directionX * 15, ARENA_WIDTH),
    y: wrapCoordinate(ship.y + directionY * 15, ARENA_HEIGHT),
    vx: ship.vx + directionX * SHIP_CONFIG.bulletSpeed,
    vy: ship.vy + directionY * SHIP_CONFIG.bulletSpeed,
    ttl: SHIP_CONFIG.bulletTtl,
  };
}

// Пересуваємо кулю тим самим фіксованим кроком на сервері та в локальному прогнозі.
export interface MutableBulletMotion {
  x: number;
  y: number;
  vx: number;
  vy: number;
  ttl: number;
} // Поля для тимчасового рендеру прогнозованої кулі.

// Оновлюємо рух кулі в переданому буфері без створення об'єкта на кожен кадр.
export function integrateBulletInto(
  bullet: BulletEntity,
  dt: number,
  output: MutableBulletMotion,
): MutableBulletMotion {
  output.x = wrapCoordinate(bullet.x + bullet.vx * dt, ARENA_WIDTH); // Загортаємо X так само, як у чистій функції.
  output.y = wrapCoordinate(bullet.y + bullet.vy * dt, ARENA_HEIGHT); // Загортаємо Y так само, як на сервері.
  output.vx = bullet.vx; // Постріл зберігає горизонтальну швидкість.
  output.vy = bullet.vy; // Постріл зберігає вертикальну швидкість.
  output.ttl = bullet.ttl - dt; // Зменшуємо життя на той самий фіксований час.
  return output; // Повертаємо повторно використаний буфер.
} // Завершуємо інтегрування кулі в надану пам'ять.

export function integrateBullet(bullet: BulletEntity, dt = FIXED_DT): BulletEntity & { readonly dead: boolean } {
  const next = { ...bullet, dead: false }; // Чистий API як і раніше повертає новий стан кулі.
  integrateBulletInto(bullet, dt, next); // Переиспользуємо формулу, спільну з мережевим рендером.
  next.dead = next.ttl <= 0; // Відмічаємо завершену кулю після оновлення таймера.
  return next; // Не змінюємо вхідну сутність.
}

// Створюємо серверний стан астероїда з позицією, швидкістю та радіусом.
export function createAsteroidState(
  id: EntityId,
  x: number,
  y: number,
  vx: number,
  vy: number,
  radius: number,
  homing = false,
): AsteroidEntity {
  return { kind: 'asteroid', id, x, y, vx, vy, radius, homing };
}

// Створюємо стан pickup без залежності від браузера чи серверних модулів.
export function createPickupState(id: EntityId, x: number, y: number, radius = 8): PickupEntity {
  return { kind: 'pickup', id, x, y, radius };
}

// Рухається астероїд і відбивається від країв арени тим самим фіксованим кроком.
export function integrateAsteroid(asteroid: AsteroidEntity, dt = FIXED_DT): AsteroidEntity {
  let x = asteroid.x + asteroid.vx * dt;
  let y = asteroid.y + asteroid.vy * dt;
  let vx = asteroid.vx;
  let vy = asteroid.vy;

  if (x < asteroid.radius) {
    x = asteroid.radius;
    vx = Math.abs(vx);
  } else if (x > ARENA_WIDTH - asteroid.radius) {
    x = ARENA_WIDTH - asteroid.radius;
    vx = -Math.abs(vx);
  }
  if (y < asteroid.radius) {
    y = asteroid.radius;
    vy = Math.abs(vy);
  } else if (y > ARENA_HEIGHT - asteroid.radius) {
    y = ARENA_HEIGHT - asteroid.radius;
    vy = -Math.abs(vy);
  }

  return { ...asteroid, x, y, vx, vy };
}

// Повертаємо нове число генератора й новий seed без Math.random().
export function nextRandom(seed: number): { readonly seed: number; readonly value: number } {
  const nextSeed = (Math.imul(seed >>> 0, 1664525) + 1013904223) >>> 0;
  return { seed: nextSeed, value: nextSeed / 4294967296 };
}

// Знаходимо найкоротшу відстань між двома координатами на арені із загортанням.
export function wrappedDelta(from: number, to: number, size: number): number {
  const direct = to - from;
  if (direct > size / 2) return direct - size;
  if (direct < -size / 2) return direct + size;
  return direct;
}

// Плавно інтерполюємо напрямок через межу -π/π.
export function interpolateAngle(from: number, to: number, alpha: number): number {
  const difference = normalizeAngle(to - from);
  return normalizeAngle(from + difference * alpha);
}
