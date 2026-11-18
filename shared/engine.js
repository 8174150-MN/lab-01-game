// Цей модуль містить однакові правила симуляції для браузера та Node.js.
// Тут немає DOM, таймерів, мережевих викликів або імпортів Node.js.

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
export function createShipState(x, y, angle = 0) {
  return {
    x,
    y,
    vx: 0,
    vy: 0,
    angle,
    hp: 3,
    score: 0,
    respawnTicks: 0,
    ackSeq: 0,
  };
}

// Обмежуємо кут інтервалом від -π до π, щоб він поміщався в Int16.
export function normalizeAngle(angle) {
  return Math.atan2(Math.sin(angle), Math.cos(angle));
}

// Перетворюємо позицію на тороїдальній арені: вилетівши з краю, корабель з'являється з іншого.
export function wrapCoordinate(value, size) {
  return ((value % size) + size) % size;
}

// Застосовуємо один input і повертаємо новий стан корабля.
// Функція чиста: вона не змінює ані ship, ані input.
export function integrate(ship, input, dt = FIXED_DT) {
  const turn = Math.max(-1, Math.min(1, Number(input.turn) || 0));
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

  return {
    ...ship,
    x: wrapCoordinate(ship.x + positionVx * dt, ARENA_WIDTH),
    y: wrapCoordinate(ship.y + positionVy * dt, ARENA_HEIGHT),
    vx,
    vy,
    angle,
  };
}

// Створюємо кулю з передбачуваним ID, щоб клієнт міг зіставити її зі знімком сервера.
export function createBullet(ship, ownerId, seq) {
  const directionX = Math.cos(ship.angle);
  const directionY = Math.sin(ship.angle);
  return {
    id: ownerId + ':' + (seq >>> 0),
    ownerId,
    seq: seq >>> 0,
    x: wrapCoordinate(ship.x + directionX * 15, ARENA_WIDTH),
    y: wrapCoordinate(ship.y + directionY * 15, ARENA_HEIGHT),
    vx: ship.vx + directionX * SHIP_CONFIG.bulletSpeed,
    vy: ship.vy + directionY * SHIP_CONFIG.bulletSpeed,
    ttl: SHIP_CONFIG.bulletTtl,
  };
}

// Пересуваємо кулю тим самим фіксованим кроком на сервері та в локальному прогнозі.
export function integrateBullet(bullet, dt = FIXED_DT) {
  const ttl = bullet.ttl - dt;
  return {
    ...bullet,
    x: wrapCoordinate(bullet.x + bullet.vx * dt, ARENA_WIDTH),
    y: wrapCoordinate(bullet.y + bullet.vy * dt, ARENA_HEIGHT),
    ttl,
    dead: ttl <= 0,
  };
}

// Створюємо серверний стан астероїда з позицією, швидкістю та радіусом.
export function createAsteroidState(id, x, y, vx, vy, radius, homing = false) {
  return { id, x, y, vx, vy, radius, homing };
}

// Створюємо стан pickup без залежності від браузера чи серверних модулів.
export function createPickupState(id, x, y, radius = 8) {
  return { id, x, y, radius };
}

// Рухається астероїд і відбивається від країв арени тим самим фіксованим кроком.
export function integrateAsteroid(asteroid, dt = FIXED_DT) {
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
export function nextRandom(seed) {
  const nextSeed = (Math.imul(seed >>> 0, 1664525) + 1013904223) >>> 0;
  return { seed: nextSeed, value: nextSeed / 4294967296 };
}

// Знаходимо найкоротшу відстань між двома координатами на арені із загортанням.
export function wrappedDelta(from, to, size) {
  const direct = to - from;
  if (direct > size / 2) return direct - size;
  if (direct < -size / 2) return direct + size;
  return direct;
}

// Плавно інтерполюємо напрямок через межу -π/π.
export function interpolateAngle(from, to, alpha) {
  const difference = normalizeAngle(to - from);
  return normalizeAngle(from + difference * alpha);
}
