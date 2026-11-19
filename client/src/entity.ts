// Підключаємо векторні типи та інтерполяцію кута без залежності від браузерного DOM.
import { MutableVector2 } from './math.js'; // Повторно використовувані вектори не створюють сміття щокроку.
import { interpolateAngle } from './sim/physics.js'; // Інтерполяція проходить межу 2π найкоротшим шляхом.
import { steerTowardTarget } from './components.js'; // Компонент додає homing без нової гілки успадкування. // Функція обходить межу кута найкоротшим шляхом.

export type EntityKind = 'ship' | 'bullet' | 'asteroid' | 'particle' | 'explosion' | 'pickup';
export interface RenderState {
  readonly x: number;
  readonly y: number;
  readonly angle: number;
}
export interface HomingComponent {
  readonly target: Entity;
  readonly acceleration: number;
}

// Базовий клас усіх об'єктів гри.
export class Entity {
  static #nextId = 1; // Приватний лічильник не можна змінити ззовні класу.
  #id: number; // Приватне поле зберігає ID поточного життя сутності.
  pos: MutableVector2;
  vel: MutableVector2;
  angle: number;
  readonly radius: number;
  readonly kind: EntityKind;
  isDead: boolean;
  previous: RenderState;
  homing?: HomingComponent;

  // Створюємо сутність із позицією, радіусом зіткнення та типом.
  constructor(x: number, y: number, radius: number, kind: EntityKind) {
    this.#id = Entity.#nextId++; // Видаємо ID і відразу збільшуємо приватний лічильник.
    this.pos = new MutableVector2(x, y); // Позиція створюється один раз на об'єкт.
    this.vel = new MutableVector2(); // Швидкість створюється один раз на об'єкт.
    this.angle = 0; // Кут потрібен кораблям та іншим напрямленим об'єктам.
    this.radius = radius; // Радіус використовується коловою системою зіткнень.
    this.kind = kind; // Тип дає World змогу вибирати сутності через ofKind.
    this.isDead = false; // Прапорець відкладеного видалення.
    this.previous = { x, y, angle: 0 }; // Попередній стан потрібен рендеру для інтерполяції.
  } // Завершуємо конструктор сутності.

  // Відкриваємо ID лише для читання.
  get id() {
    return this.#id;
  } // Зовнішній код не може підмінити ідентифікатор.

  // Видаємо новий ID і очищаємо стан об'єкта, який повернувся з пулу.
  protected reactivate(x: number, y: number): void {
    this.#id = Entity.#nextId++; // Пул не повторює ID попереднього життя сутності.
    this.pos.set(x, y); // Переставляємо позицію в уже наявному векторі.
    this.vel.set(0, 0); // Скидаємо стару швидкість у вже наявному векторі.
    this.angle = 0; // Очищаємо попередній напрямок.
    this.isDead = false; // Повертаємо об'єкт до активного стану.
    this.previous = { x, y, angle: 0 }; // Перший кадр не інтерполюється зі старої позиції.
  } // Завершуємо повторну активацію об'єкта.

  // Фіксуємо стан перед наступним кроком фізики.
  capturePrevious(): void {
    this.previous = { x: this.pos.x, y: this.pos.y, angle: this.angle }; // Копіюємо примітиви, не посилання на вектор.
  } // Завершуємо збереження попереднього стану.

  // Повертаємо позицію та кут між двома кроками симуляції.
  renderState(alpha: number, width: number, height: number): RenderState {
    let dx = this.pos.x - this.previous.x; // Знаходимо переміщення по горизонталі.
    let dy = this.pos.y - this.previous.y; // Знаходимо переміщення по вертикалі.
    if (width > 0 && Math.abs(dx) > width / 2) dx -= Math.sign(dx) * width; // Вибираємо короткий шлях крізь горизонтальний wrap.
    if (height > 0 && Math.abs(dy) > height / 2) dy -= Math.sign(dy) * height; // Вибираємо короткий шлях крізь вертикальний wrap.
    let x = this.previous.x + dx * alpha; // Інтерполюємо горизонтальну позицію.
    let y = this.previous.y + dy * alpha; // Інтерполюємо вертикальну позицію.
    if (width > 0) x = ((x % width) + width) % width; // Нормалізуємо X після інтерполяції wrap.
    if (height > 0) y = ((y % height) + height) % height; // Нормалізуємо Y після інтерполяції wrap.
    return { x, y, angle: interpolateAngle(this.previous.angle, this.angle, alpha) }; // Повертаємо стан для малювання.
  } // Завершуємо інтерполяцію.

  // Рухаємо сутність на один фіксований крок.
  update(dt: number, _width?: number, _height?: number, _input?: import('./sim/physics.js').ShipControls): void {
    steerTowardTarget(this, dt); // Застосовуємо самонаведення, якщо його додали композицією.
    this.pos.set(this.pos.x + this.vel.x * dt, this.pos.y + this.vel.y * dt); // Рухаємось без тимчасових Vector2.
  } // Завершуємо оновлення базової сутності.

  // Базовий render нічого не малює; дочірні сутності задають свій вигляд.
  render(_ctx: CanvasRenderingContext2D, _alpha?: number, _width?: number, _height?: number): void {} // Метод-заглушка дає World єдиний інтерфейс для всіх сутностей.
} // Завершуємо базовий клас.
