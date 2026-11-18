// Цей модуль містить лише обчислення фізики й не звертається до DOM або canvas.
// Кожне налаштування корабля зберігається в одному незмінному об'єкті.
export const SHIP_CONFIG = Object.freeze({
  turnSpeed: Math.PI, // Кут повороту корабля за секунду вимірюється в радіанах.
  acceleration: 420, // Сила тяги задає прискорення в пікселях за секунду в квадраті.
  drag: 0.985, // Коефіцієнт тертя застосовується один раз на стандартний крок.
  maxSpeed: 360, // Обмеження швидкості не дає кораблю розганятися без меж.
});

export interface LocalShipState {
  readonly x: number;
  readonly y: number;
  readonly vx: number;
  readonly vy: number;
  readonly angle: number;
}
export interface ShipControls {
  readonly left?: boolean;
  readonly right?: boolean;
  readonly thrust?: boolean;
  readonly ArrowLeft?: boolean;
  readonly ArrowRight?: boolean;
  readonly ArrowUp?: boolean;
}
export interface IntegratedShipState extends LocalShipState {
  readonly thrusting: boolean;
}
interface PhysicsConfig {
  readonly turnSpeed: number;
  readonly acceleration: number;
  readonly drag: number;
  readonly maxSpeed: number;
}

// Чисте обчислення приймає стан, ввід і dt та повертає новий стан без мутацій.
export function integrate(
  ship: LocalShipState,
  input: ShipControls,
  dt: number,
  config: PhysicsConfig = SHIP_CONFIG,
): IntegratedShipState {
  // Визначаємо напрямок повороту з клавіш, які передав викликач.
  const turn = Number(Boolean(input.left)) * -1 + Number(Boolean(input.right));
  // Обчислюємо новий кут незалежно від частоти кадрів.
  const angle = ship.angle + turn * config.turnSpeed * dt;
  // Читаємо прапорець тяги один раз, щоб використати його в стані та швидкості.
  const thrusting = Boolean(input.thrust);
  // Додаємо прискорення вздовж напрямку носа корабля.
  let vx = ship.vx + (thrusting ? Math.cos(angle) * config.acceleration * dt : 0);
  // Додаємо вертикальну складову того самого прискорення.
  let vy = ship.vy + (thrusting ? Math.sin(angle) * config.acceleration * dt : 0);
  // Перераховуємо тертя на довільний фіксований крок.
  const drag = config.drag ** (dt * 60);
  // Застосовуємо тертя до горизонтальної швидкості.
  vx *= drag;
  // Застосовуємо тертя до вертикальної швидкості.
  vy *= drag;
  // Вимірюємо повну швидкість корабля.
  const speed = Math.hypot(vx, vy);
  // Знаходимо коефіцієнт стискання лише тоді, коли швидкість перевищила межу.
  const scale = speed > config.maxSpeed ? config.maxSpeed / speed : 1;
  // Повертаємо нові координати, швидкості й кут, не змінюючи вхідний ship.
  return {
    x: ship.x + vx * dt, // Пересуваємо корабель по горизонталі за цей крок.
    y: ship.y + vy * dt, // Пересуваємо корабель по вертикалі за цей крок.
    vx: vx * scale, // Зберігаємо горизонтальну швидкість після обмеження.
    vy: vy * scale, // Зберігаємо вертикальну швидкість після обмеження.
    angle, // Зберігаємо новий напрямок корабля.
    thrusting, // Повертаємо стан двигуна для малювання полум'я.
  };
}

// Інтерполяція кута обходить межу 2π найкоротшим шляхом.
export function interpolateAngle(from: number, to: number, alpha: number): number {
  // Зводимо різницю кутів до інтервалу [-π, π].
  const delta = Math.atan2(Math.sin(to - from), Math.cos(to - from));
  // Повертаємо кут між попереднім і поточним значеннями.
  return from + delta * alpha;
}
