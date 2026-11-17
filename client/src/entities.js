// Базовий клас дає всім сутностям ID, позицію, швидкість і коловий радіус.
import { Entity } from './entity.js'; // Наслідування використовується лише на один рівень.
import { Vector2 } from './math.js'; // Вектори потрібні руху куль, астероїдів і частинок.
import { integrate } from './sim/physics.js'; // Чиста фізична функція не знає про DOM чи canvas.
import { bounceAtBounds } from './sim/arena.js'; // Астероїди відбиваються від стін арени.
import { withPickup } from './components.js'; // Pickup додається композицією.
import { emit } from './events.js'; // Ігрові сутності сповіщають HUD та звук через події.
import { sprites, drawSprite } from './sprites.js'; // Рендер використовує завантажені sprite sheets.

// Клас гравця додає керування, життя, стрільбу та малювання до Entity.
export class Ship extends Entity {
  #hp = 3; // Приватне поле не дає змінити життя напряму.

  // Створюємо корабель у заданій точці.
  constructor(x, y) {
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
  update(dt, width, height, input = {}) {
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
    this.pos = new Vector2(state.x, state.y); // Зберігаємо нову позицію.
    this.vel = new Vector2(state.vx, state.vy); // Зберігаємо обмежену швидкість.
    this.angle = state.angle; // Зберігаємо напрямок корабля.
    this.isThrusting = state.thrusting; // Передаємо стан двигуна рендеру.
    this.cooldown = Math.max(0, this.cooldown - dt); // Зменшуємо затримку між пострілами.
  } // Завершуємо крок фізики корабля.

  // Створюємо кулю перед носом корабля з успадкованою швидкістю.
  fire(world) {
    if (this.isDead || this.cooldown > 0) return null; // Не стріляємо мертвим кораблем або під час кулдауну.
    const muzzle = this.pos.add(Vector2.fromAngle(this.angle).scale(this.radius)); // Знаходимо точку на носі.
    const bullet = new Bullet(muzzle.x, muzzle.y, this.angle, this.vel, this.id); // Передаємо кулі напрямок, швидкість і власника.
    world.spawn(bullet); // Додаємо кулю в карту світу.
    this.cooldown = 0.2; // Встановлюємо паузу між пострілами.
    emit('fired', { x: muzzle.x, y: muzzle.y }); // Шина запускає звук без імпорту audio.js.
    return bullet; // Повертаємо кулю для наочності та навчальних прикладів.
  } // Завершуємо метод стрільби.

  // Малюємо корабель у проміжному стані між двома кроками симуляції.
  render(ctx, alpha = 1, width = 0, height = 0) {
    if (this.isDead) return; // Мертвий корабель вже не видно.
    const state = this.renderState(alpha, width, height); // Інтерполюємо позицію та кут.
    const image = sprites.hero; // Беремо завантажений спрайт корабля.
    ctx.save(); // Зберігаємо трансформації полотна для інших об'єктів.
    ctx.translate(state.x, state.y); // Пересуваємо початок координат у центр корабля.
    ctx.rotate(state.angle + Math.PI / 2); // Повертаємо спрайт, який у файлі спрямований угору.
    if (image)
      drawSprite(ctx, image, 0, 0, this.radius * 3, this.radius * 3, 0, {
        x: 0,
        y: 0,
        w: image.width,
        h: image.height,
      }); // Малюємо корабель із прямокутника sprite sheet.
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
  // Створюємо кулю з успадкованою швидкістю корабля.
  constructor(x, y, angle, inheritedVelocity = new Vector2(), ownerId = null) {
    super(x, y, 3, 'bullet'); // Задаємо базові поля кулі.
    this.vel = Vector2.fromAngle(angle).scale(500).add(inheritedVelocity); // Поєднуємо швидкість пострілу зі швидкістю корабля.
    this.ownerId = ownerId; // Зберігаємо ID стрільця, щоб куля не влучала в нього.
    this.ttl = 1.5; // Куля зникає через півтори секунди.
    this.angle = angle; // Кут використовується для малювання кадру.
  } // Завершуємо створення кулі.

  // Зменшуємо час життя кулі.
  update(dt) {
    this.ttl -= dt; // Кожен крок фізики віднімає його тривалість.
    if (this.ttl <= 0) this.isDead = true; // Прострочена куля піде під час sweep.
    super.update(dt); // Рухаємо кулю базовим методом.
  } // Завершуємо оновлення кулі.

  // Малюємо кадр зі sprite sheet куль.
  render(ctx, alpha = 1, width = 0, height = 0) {
    const state = this.renderState(alpha, width, height); // Отримуємо згладжену позицію.
    const image = sprites.bullets; // Читаємо завантажений лист куль.
    if (image) {
      const frame = Math.floor((1.5 - this.ttl) * 12) % 4;
      drawSprite(ctx, image, state.x, state.y, 16, 16, this.angle, { x: frame * 32, y: 0, w: 32, h: 32 });
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
  // Створюємо перешкоду з заданим розміром.
  constructor(x, y, radius = 18) {
    super(x, y, radius, 'asteroid'); // Передаємо базі положення, радіус і тип.
    this.vel = new Vector2((Math.random() - 0.5) * 100, (Math.random() - 0.5) * 100); // Задаємо повільний випадковий дрейф.
  } // Завершуємо створення астероїда.

  // Пересуваємо астероїд і відбиваємо його від стін.
  update(dt, width, height) {
    super.update(dt); // Спершу застосовуємо швидкість за час dt.
    const bounce = bounceAtBounds(this.pos, this.vel, width, height, this.radius); // Повертаємо відбитий стан у межі.
    this.pos = new Vector2(bounce.position.x, bounce.position.y); // Зберігаємо скориговану позицію.
    this.vel = new Vector2(bounce.velocity.x, bounce.velocity.y); // Зберігаємо напрямок після удару.
  } // Завершуємо оновлення астероїда.

  // Малюємо повний кадр листа астероїдів.
  render(ctx, alpha = 1, width = 0, height = 0) {
    const state = this.renderState(alpha, width, height); // Отримуємо інтерпольовану позицію.
    const image = sprites.asteroid; // Беремо завантажений лист астероїда.
    if (image)
      drawSprite(ctx, image, state.x, state.y, this.radius * 2.4, this.radius * 2.4, state.angle, {
        x: 0,
        y: 0,
        w: image.width,
        h: image.height,
      }); // Вирізаємо джерельний прямокутник зі спрайта.
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
  // Створюємо частинку з випадковим напрямком.
  constructor(x, y) {
    super(x, y, 1, 'particle'); // Частинка майже не впливає на зіткнення.
    this.vel = new Vector2((Math.random() - 0.5) * 200, (Math.random() - 0.5) * 200); // Розкидаємо її в усі боки.
    this.ttl = 0.35 + Math.random() * 0.45; // Даємо частинці короткий випадковий час життя.
  } // Завершуємо створення частинки.

  // Зменшуємо життя частинки й рухаємо її.
  update(dt) {
    this.ttl -= dt; // Віднімаємо фіксований крок від часу життя.
    if (this.ttl <= 0) this.isDead = true; // Позначаємо зниклу частинку для sweep.
    super.update(dt); // Пересуваємо частинку базовою фізикою.
  } // Завершуємо оновлення частинки.

  // Малюємо одну маленьку частинку.
  render(ctx, alpha = 1, width = 0, height = 0) {
    const state = this.renderState(alpha, width, height); // Отримуємо інтерпольовану позицію.
    ctx.globalAlpha = Math.max(0, this.ttl); // Робимо частинку прозорішою перед зникненням.
    ctx.fillStyle = '#ff8c42'; // Задаємо колір полум'я.
    ctx.fillRect(state.x, state.y, 3, 3); // Малюємо маленький квадрат.
    ctx.globalAlpha = 1; // Повертаємо прозорість для наступних об'єктів.
  } // Завершуємо малювання частинки.
} // Завершуємо клас Particle.

// Вибух є окремою сутністю та містить багато короткоживучих частинок.
export class Explosion extends Entity {
  // Створюємо групу частинок у точці зіткнення.
  constructor(x, y, count = 15) {
    super(x, y, 0, 'explosion'); // Вибух сам не має радіуса зіткнення.
    this.particles = Array.from({ length: count }, () => new Particle(x, y)); // Створюємо дочірні частинки.
  } // Завершуємо створення вибуху.

  // Оновлюємо всі частинки й прибираємо вибух, коли вони скінчились.
  update(dt, _width, _height) {
    for (const particle of this.particles) {
      particle.capturePrevious();
      particle.update(dt);
    } // Кожна частинка має власний рух.
    this.particles = this.particles.filter((particle) => !particle.isDead); // Зберігаємо лише частинки, що ще живі.
    if (this.particles.length === 0) this.isDead = true; // Видаляємо групу після останньої частинки.
  } // Завершуємо оновлення вибуху.

  // Малюємо кожну живу частинку групи.
  render(ctx, alpha = 1, width = 0, height = 0) {
    for (const particle of this.particles) particle.render(ctx, alpha, width, height); // Передаємо інтерполяцію кожній частинці.
  } // Завершуємо малювання вибуху.
} // Завершуємо клас Explosion.

// Pickup має позицію та колізію, але поведінку отримує через компонент.
export class Pickup extends Entity {
  // Створюємо нерухоме місце з ефектом для корабля.
  constructor(x, y, effect = (ship) => ship.heal()) {
    super(x, y, 8, 'pickup'); // Pickup має власний радіус для окремої системи зіткнень.
    this.vel = new Vector2(); // Предмет залишається на місці.
    withPickup(this, effect); // Композиція додає дію без наслідування від Ship.
  } // Завершуємо створення предмета.

  // Малюємо предмет на координатах після інтерполяції.
  render(ctx, alpha = 1, width = 0, height = 0) {
    const state = this.renderState(alpha, width, height); // Отримуємо згладжену позицію.
    ctx.fillStyle = '#4ade80'; // Задаємо зелений колір лікувального бонусу.
    ctx.fillRect(state.x - 5, state.y - 5, 10, 10); // Малюємо квадрат, який легко побачити.
  } // Завершуємо малювання pickup.
} // Завершуємо клас Pickup.

// Зберігаємо стару фабричну назву, щоб наявні імпорти не зламалися.
export function createHealthPickup(x, y) {
  return new Pickup(x, y);
} // Фабрика повертає аптечку.
