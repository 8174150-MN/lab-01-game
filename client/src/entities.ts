// Базовий клас дає всім сутностям ID, позицію, швидкість і коловий радіус.
import { Entity } from './entity.js'; // Наслідування використовується лише на один рівень.
import { integrate } from './sim/physics.js'; // Чиста фізична функція не знає про DOM чи canvas.
import { withPickup } from './components.js'; // Pickup додається композицією.
import { emit } from './events.js'; // Ігрові сутності сповіщають HUD та звук через події.
import { sprites, drawSprite, fullSpriteFrame } from './sprites.js'; // Рендер використовує кешовані рамки sprite sheets.
import type { World } from './world.js';
import type { ShipControls } from './sim/physics.js';
const bulletFrames = [
  { x: 0, y: 0, w: 32, h: 32 },
  { x: 32, y: 0, w: 32, h: 32 },
  { x: 64, y: 0, w: 32, h: 32 },
  { x: 96, y: 0, w: 32, h: 32 },
]; // Часті кадри sprite sheet не створюють новий об'єкт під час малювання.

export interface Ship extends Entity {
  readonly kind: 'ship';
  cooldown: number;
  isThrusting: boolean;
}
export interface Bullet extends Entity {
  readonly kind: 'bullet';
  ownerId: number | null;
  ttl: number;
}
export interface Asteroid extends Entity {
  readonly kind: 'asteroid';
}
export interface Particle extends Entity {
  readonly kind: 'particle';
  ttl: number;
}
export interface Explosion extends Entity {
  readonly kind: 'explosion';
  particles: Particle[];
}
export interface Pickup extends Entity {
  readonly kind: 'pickup';
  onPickup?: (ship: Ship) => void;
}
export type GameEntity = Ship | Bullet | Asteroid | Particle | Explosion | Pickup;

// Клас гравця додає керування, життя, стрільбу та малювання до Entity.
export class Ship extends Entity {
  declare readonly kind: 'ship';
  cooldown: number;
  isThrusting: boolean;
  #hp = 3; // Приватне поле не дає змінити життя напряму.

  // Створюємо корабель у заданій точці.
  constructor(x: number, y: number) {
    super(x, y, 15, 'ship'); // Базовий клас створює ID і фізичні поля.
    this.cooldown = 0; // Таймер обмежує частоту пострілів.
    this.isThrusting = false; // Прапорець вмикає полум'я двигуна.
    emit('shipSpawned', { hp: this.#hp }); // HUD отримує початкову кількість життів.
  } // Завершуємо створення корабля.

  // Повертаємо життя без доступу до приватного поля.
  get hp() {
    return this.#hp;
  } // Геттер є публічним інтерфейсом для HUD.

  // Застосовуємо одне влучання.
  takeDamage() {
    this.#hp -= 1; // Віднімаємо одне життя.
    if (this.#hp <= 0) this.isDead = true; // Позначаємо корабель мертвим після останнього влучання.
  } // Завершуємо обробку шкоди.

  // Додаємо одне життя аптечкою.
  heal() {
    this.#hp += 1; // Збільшуємо приватне поле лише через метод корабля.
    emit('healed', { hp: this.#hp }); // HUD оновлює число життів.
  } // Завершуємо лікування.

  // Перераховуємо стан корабля одним фіксованим кроком.
  update(dt: number, _width: number, _height: number, input: ShipControls = {}) {
    if (this.isDead) return; // Мертвий корабель не рухається.
    const state = integrate(
      { x: this.pos.x, y: this.pos.y, vx: this.vel.x, vy: this.vel.y, angle: this.angle },
      {
        left: input.left ?? input.ArrowLeft,
        right: input.right ?? input.ArrowRight,
        thrust: input.thrust ?? input.ArrowUp,
      },
      dt,
    ); // Отримуємо новий стан без DOM-залежностей.
    this.pos.set(state.x, state.y); // Зберігаємо нову позицію у вже створеному векторі.
    this.vel.set(state.vx, state.vy); // Зберігаємо швидкість у вже створеному векторі.
    this.angle = state.angle; // Зберігаємо напрямок корабля.
    this.isThrusting = state.thrusting; // Передаємо стан двигуна рендеру.
    this.cooldown = Math.max(0, this.cooldown - dt); // Зменшуємо затримку між пострілами.
  } // Завершуємо крок фізики корабля.

  // Створюємо кулю перед носом корабля з успадкованою швидкістю.
  fire(world: World): Bullet | null {
    if (this.isDead || this.cooldown > 0) return null; // Не стріляємо мертвим кораблем або під час кулдауну.
    const muzzleX = this.pos.x + Math.cos(this.angle) * this.radius; // Рахуємо X дула без тимчасового вектора.
    const muzzleY = this.pos.y + Math.sin(this.angle) * this.radius; // Рахуємо Y дула без тимчасового вектора.
    const bullet = world.spawnBullet(muzzleX, muzzleY, this.angle, this.vel, this.id); // Беремо кулю з пулу або створюємо вперше.
    this.cooldown = 0.2; // Встановлюємо паузу між пострілами.
    emit('fired', { x: muzzleX, y: muzzleY }); // Шина запускає звук без імпорту audio.js.
    return bullet; // Повертаємо кулю для наочності та навчальних прикладів.
  } // Завершуємо метод стрільби.

  // Малюємо корабель у проміжному стані між двома кроками симуляції.
  render(ctx: CanvasRenderingContext2D, alpha = 1, width = 0, height = 0): void {
    if (this.isDead) return; // Мертвий корабель вже не видно.
    const state = this.renderState(alpha, width, height); // Інтерполюємо позицію та кут.
    const image = sprites.hero; // Беремо завантажений спрайт корабля.
    ctx.save(); // Зберігаємо трансформації полотна для інших об'єктів.
    ctx.translate(state.x, state.y); // Пересуваємо початок координат у центр корабля.
    ctx.rotate(state.angle + Math.PI / 2); // Повертаємо спрайт, який у файлі спрямований угору.
    if (image)
      drawSprite(ctx, image, 0, 0, this.radius * 3, this.radius * 3, 0, fullSpriteFrame(image)); // Малюємо корабель із кешованої повної рамки.
    else {
      ctx.beginPath();
      ctx.moveTo(20, 0);
      ctx.lineTo(-15, -13);
      ctx.lineTo(-10, 0);
      ctx.lineTo(-15, 13);
      ctx.closePath();
      ctx.strokeStyle = '#66fcf1';
      ctx.stroke();
    } // Малюємо запасний трикутник, коли спрайт не завантажився.
    if (this.isThrusting) {
      ctx.beginPath();
      ctx.moveTo(-this.radius, -4);
      ctx.lineTo(-this.radius - 12, 0);
      ctx.lineTo(-this.radius, 4);
      ctx.strokeStyle = '#ff8c42';
      ctx.stroke();
    } // Додаємо полум'я під час тяги.
    ctx.restore(); // Повертаємо початковий стан canvas.
  } // Завершуємо малювання корабля.
} // Завершуємо клас Ship.

// Куля має швидкість, власника і короткий час життя.
export class Bullet extends Entity {
  declare readonly kind: 'bullet';
  ownerId: number | null;
  ttl: number;
  // Створюємо кулю з успадкованою швидкістю корабля.
  constructor(
    x: number,
    y: number,
    angle: number,
    inheritedVelocity: Readonly<{ x: number; y: number }> = { x: 0, y: 0 },
    ownerId: number | null = null,
  ) {
    super(x, y, 3, 'bullet'); // Задаємо базові поля кулі.
    this.vel.set(Math.cos(angle) * 500 + inheritedVelocity.x, Math.sin(angle) * 500 + inheritedVelocity.y); // Поєднуємо швидкості без нового вектора.
    this.ownerId = ownerId; // Зберігаємо ID стрільця, щоб куля не влучала в нього.
    this.ttl = 1.5; // Куля зникає через півтори секунди.
    this.angle = angle; // Кут використовується для малювання кадру.
  } // Завершуємо створення кулі.

  // Перезапускаємо кулю, яку World дістав із пулу.
  reset(
    x: number,
    y: number,
    angle: number,
    inheritedVelocity: Readonly<{ x: number; y: number }>,
    ownerId: number,
  ): this {
    this.reactivate(x, y); // Оновлюємо ID, позицію та попередній стан.
    this.vel.set(Math.cos(angle) * 500 + inheritedVelocity.x, Math.sin(angle) * 500 + inheritedVelocity.y); // Задаємо швидкість нового пострілу.
    this.ownerId = ownerId; // Призначаємо кулю новому власнику.
    this.ttl = 1.5; // Повертаємо повний час життя кулі.
    this.angle = angle; // Повертаємо напрямок спрайта.
    return this; // Дозволяємо World одразу додати кулю в Map.
  } // Завершуємо повторну активацію кулі.

  // Зменшуємо час життя кулі.
  update(dt: number): void {
    this.ttl -= dt; // Кожен крок фізики віднімає його тривалість.
    if (this.ttl <= 0) this.isDead = true; // Прострочена куля піде під час sweep.
    super.update(dt); // Рухаємо кулю базовим методом.
  } // Завершуємо оновлення кулі.

  // Малюємо кадр зі sprite sheet куль.
  render(ctx: CanvasRenderingContext2D, alpha = 1, width = 0, height = 0): void {
    const state = this.renderState(alpha, width, height); // Отримуємо згладжену позицію.
    const image = sprites.bullets; // Читаємо завантажений лист куль.
    if (image) {
      const frame = Math.floor((1.5 - this.ttl) * 12) % 4;
      drawSprite(ctx, image, state.x, state.y, 16, 16, this.angle, bulletFrames[frame] ?? null);
    } // Вибираємо анімаційний кадр за віком кулі.
    else {
      ctx.beginPath();
      ctx.arc(state.x, state.y, this.radius, 0, Math.PI * 2);
      ctx.fillStyle = '#ffe66d';
      ctx.fill();
    } // Малюємо запасне коло без спрайта.
  } // Завершуємо малювання кулі.
} // Завершуємо клас Bullet.

// Астероїд рухається і відбивається від країв замість загортання.
export class Asteroid extends Entity {
  declare readonly kind: 'asteroid';
  // Створюємо перешкоду з заданим розміром.
  constructor(x: number, y: number, radius = 18) {
    super(x, y, radius, 'asteroid'); // Передаємо базі положення, радіус і тип.
    this.vel.set((Math.random() - 0.5) * 100, (Math.random() - 0.5) * 100); // Задаємо повільний випадковий дрейф.
  } // Завершуємо створення астероїда.

  // Пересуваємо астероїд і відбиваємо його від стін.
  update(dt: number, width: number, height: number): void {
    super.update(dt); // Спершу застосовуємо швидкість за час dt.
    let vx = this.vel.x; // Беремо поточну горизонтальну швидкість.
    let vy = this.vel.y; // Беремо поточну вертикальну швидкість.
    if (this.pos.x < this.radius || this.pos.x > width - this.radius) vx *= -1; // Відбиваємо рух від лівої чи правої стіни.
    if (this.pos.y < this.radius || this.pos.y > height - this.radius) vy *= -1; // Відбиваємо рух від верхньої чи нижньої стіни.
    this.pos.set(
      Math.max(this.radius, Math.min(width - this.radius, this.pos.x)),
      Math.max(this.radius, Math.min(height - this.radius, this.pos.y)),
    ); // Тримаємо центр у межах арени.
    this.vel.set(vx, vy); // Записуємо відбиту швидкість без створення Vector2.
  } // Завершуємо оновлення астероїда.

  // Малюємо повний кадр листа астероїдів.
  render(ctx: CanvasRenderingContext2D, alpha = 1, width = 0, height = 0): void {
    const state = this.renderState(alpha, width, height); // Отримуємо інтерпольовану позицію.
    const image = sprites.asteroid; // Беремо завантажений лист астероїда.
    if (image)
      drawSprite(
        ctx,
        image,
        state.x,
        state.y,
        this.radius * 2.4,
        this.radius * 2.4,
        state.angle,
        fullSpriteFrame(image),
      ); // Беремо повну рамку з кешу.
    else {
      ctx.beginPath();
      ctx.arc(state.x, state.y, this.radius, 0, Math.PI * 2);
      ctx.strokeStyle = '#aaa';
      ctx.stroke();
    } // Малюємо контур як резервний варіант.
  } // Завершуємо малювання астероїда.
} // Завершуємо клас Asteroid.

// Частинка — короткоживуча сутність усередині вибуху.
export class Particle extends Entity {
  declare readonly kind: 'particle';
  static #pool: Particle[] = []; // Зберігаємо завершені частинки для наступних вибухів.
  ttl: number;
  // Створюємо частинку з випадковим напрямком.
  constructor(x: number, y: number) {
    super(x, y, 1, 'particle'); // Частинка майже не впливає на зіткнення.
    this.vel.set((Math.random() - 0.5) * 200, (Math.random() - 0.5) * 200); // Розкидаємо її в усі боки.
    this.ttl = 0.35 + Math.random() * 0.45; // Даємо частинці короткий випадковий час життя.
  } // Завершуємо створення частинки.

  // Повертаємо частинку з пулу або створюємо нову під час першого піку.
  static acquire(x: number, y: number): Particle {
    const particle = this.#pool.pop(); // Перевіряємо, чи є вільний екземпляр.
    if (!particle) return new Particle(x, y); // Створюємо об'єкт лише коли пул порожній.
    particle.reactivate(x, y); // Видаємо новий ID та очищаємо його минулу позицію.
    particle.vel.set((Math.random() - 0.5) * 200, (Math.random() - 0.5) * 200); // Задаємо новий випадковий рух.
    particle.ttl = 0.35 + Math.random() * 0.45; // Повертаємо випадковий час життя.
    return particle; // Передаємо активну частинку новому вибуху.
  } // Завершуємо отримання об'єкта з пулу.

  // Повертаємо зниклу частинку у пул із обмеженим розміром.
  static release(particle: Particle): void {
    if (this.#pool.length >= 512) return; // Не дозволяємо запасу перевищити задану місткість.
    this.#pool.push(particle); // Зберігаємо об'єкт для наступного ефекту.
  } // Завершуємо повернення об'єкта.

  // Зменшуємо життя частинки й рухаємо її.
  update(dt: number): void {
    this.ttl -= dt; // Віднімаємо фіксований крок від часу життя.
    if (this.ttl <= 0) this.isDead = true; // Позначаємо зниклу частинку для sweep.
    super.update(dt); // Пересуваємо частинку базовою фізикою.
  } // Завершуємо оновлення частинки.

  // Малюємо одну маленьку частинку.
  render(ctx: CanvasRenderingContext2D, alpha = 1, width = 0, height = 0): void {
    const state = this.renderState(alpha, width, height); // Отримуємо інтерпольовану позицію.
    ctx.globalAlpha = Math.max(0, this.ttl); // Робимо частинку прозорішою перед зникненням.
    ctx.fillStyle = '#ff8c42'; // Задаємо колір полум'я.
    ctx.fillRect(state.x, state.y, 3, 3); // Малюємо маленький квадрат.
    ctx.globalAlpha = 1; // Повертаємо прозорість для наступних об'єктів.
  } // Завершуємо малювання частинки.
} // Завершуємо клас Particle.

// Вибух є окремою сутністю та містить багато короткоживучих частинок.
export class Explosion extends Entity {
  declare readonly kind: 'explosion';
  particles: Particle[];
  // Створюємо групу частинок у точці зіткнення.
  constructor(x: number, y: number, count = 15) {
    super(x, y, 0, 'explosion'); // Вибух сам не має радіуса зіткнення.
    this.particles = Array.from({ length: count }, () => Particle.acquire(x, y)); // Беремо дочірні частинки з пулу.
  } // Завершуємо створення вибуху.

  // Оновлюємо всі частинки й прибираємо вибух, коли вони скінчились.
  update(dt: number, _width: number, _height: number): void {
    let activeCount = 0; // Записуємо живі частинки назад у той самий масив.
    for (const particle of this.particles) {
      particle.capturePrevious(); // Зберігаємо попередню координату для рендеру.
      particle.update(dt); // Рухаємось за фіксований крок.
      if (particle.isDead)
        Particle.release(particle); // Повертаємо завершений ефект у пул.
      else this.particles[activeCount++] = particle; // Ущільнюємо живі елементи без filter-масиву.
    } // Завершуємо оновлення частинок.
    this.particles.length = activeCount; // Відкидаємо застарілі посилання зі старого хвоста.
    if (this.particles.length === 0) this.isDead = true; // Видаляємо групу після останньої частинки.
  } // Завершуємо оновлення вибуху.

  // Малюємо кожну живу частинку групи.
  render(ctx: CanvasRenderingContext2D, alpha = 1, width = 0, height = 0): void {
    for (const particle of this.particles) particle.render(ctx, alpha, width, height); // Передаємо інтерполяцію кожній частинці.
  } // Завершуємо малювання вибуху.
} // Завершуємо клас Explosion.

// Pickup має позицію та колізію, але поведінку отримує через компонент.
export class Pickup extends Entity {
  declare readonly kind: 'pickup';
  onPickup?: (ship: Ship) => void;
  // Створюємо нерухоме місце з ефектом для корабля.
  constructor(x: number, y: number, effect: (ship: Ship) => void = (ship) => ship.heal()) {
    super(x, y, 8, 'pickup'); // Pickup має власний радіус для окремої системи зіткнень.
    this.vel.set(0, 0); // Предмет залишається на місці без нового вектора.
    withPickup(this, effect); // Композиція додає дію без наслідування від Ship.
  } // Завершуємо створення предмета.

  // Малюємо предмет на координатах після інтерполяції.
  render(ctx: CanvasRenderingContext2D, alpha = 1, width = 0, height = 0): void {
    const state = this.renderState(alpha, width, height); // Отримуємо згладжену позицію.
    ctx.fillStyle = '#4ade80'; // Задаємо зелений колір лікувального бонусу.
    ctx.fillRect(state.x - 5, state.y - 5, 10, 10); // Малюємо квадрат, який легко побачити.
  } // Завершуємо малювання pickup.
} // Завершуємо клас Pickup.

// Зберігаємо стару фабричну назву, щоб наявні імпорти не зламалися.
export function createHealthPickup(x: number, y: number): Pickup {
  return new Pickup(x, y);
} // Фабрика повертає аптечку.
