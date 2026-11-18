// World owns entities and coordinates updates, collisions, removal, and drawing.
import { Explosion, Pickup } from './entities.js'; // Вибух зберігає короткоживучі частинки в одному об'єкті.
import { findCircleCollisions } from './sim/collision.js'; // Геометрична перевірка ізольована від правил гри.
import { wrapPosition } from './sim/arena.js'; // Арена окремо задає загортання за межами.
import { emit } from './events.js'; // HUD і звук отримують факти про ігрові події.
import { Vector2 } from './math.js'; // Створюємо нову позицію, адже координати вектора readonly.
import type { GameEntity } from './entities.js';
import type { ShipControls } from './sim/physics.js';
import type { Explosion as ExplosionEntity } from './entities.js';

function isEntityKind<Kind extends GameEntity['kind']>(
  entity: GameEntity,
  kind: Kind,
): entity is Extract<GameEntity, { kind: Kind }> {
  return entity.kind === kind;
}

export class World {
  #entities = new Map<number, GameEntity>(); // Приватна Map зберігає сутності за їхніми ID.
  width: number;
  height: number;
  score: number;

  // Створюємо арену з розмірами CSS-пікселів.
  constructor(width: number, height: number) {
    this.width = width; // Ширина визначає горизонтальні межі.
    this.height = height; // Висота визначає вертикальні межі.
    this.score = 0; // Рахунок починається з нуля.
  } // Завершуємо створення світу.

  // Додаємо нову сутність до Map.
  spawn<EntityType extends GameEntity>(entity: EntityType): EntityType {
    this.#entities.set(entity.id, entity); // ID є ключем і не змінюється протягом життя сутності.
    return entity; // Повертаємо сутність для зручного ланцюжка викликів.
  } // Завершуємо spawn.

  // Позначаємо об'єкт мертвим, щоб sweep прибрав його наприкінці кроку.
  despawn(id: number): void {
    const entity = this.#entities.get(id); // Знаходимо сутність за ID.
    if (entity) entity.isDead = true; // Не змінюємо Map під час обходу сутностей.
  } // Завершуємо відкладене видалення.

  // Повертаємо сутність за ID або undefined.
  get(id: number): GameEntity | undefined {
    return this.#entities.get(id);
  } // Map виконує пошук за ключем.

  // Дозволяємо перебирати всі сутності через for...of.
  [Symbol.iterator](): MapIterator<GameEntity> {
    return this.#entities.values();
  } // Ітератор не створює копію списку.

  // Віддаємо генератор для одного виду сутностей.
  *ofKind<Kind extends GameEntity['kind']>(kind: Kind): Generator<Extract<GameEntity, { kind: Kind }>> {
    for (const entity of this.#entities.values()) {
      // Послідовно читаємо значення Map.
      if (isEntityKind(entity, kind)) yield entity; // Фільтр за kind звужує сутність до конкретного класу.
    } // Завершуємо обхід карти.
  } // Завершуємо генератор виду.

  // Створюємо вибух як сутність, що містить багато частинок.
  spawnExplosion(x: number, y: number, count = 15): ExplosionEntity {
    return this.spawn(new Explosion(x, y, count)); // Додаємо групу частинок до того самого entity store.
  } // Завершуємо створення вибуху.

  // Оновлюємо фізику, обробляємо зіткнення та прибираємо мертвих.
  step(dt: number, input: ShipControls & { readonly firePressed?: boolean } = {}) {
    const active = [...this.#entities.values()]; // Знімок не включає сутності, додані посеред цього кроку.
    for (const entity of active) {
      // Кожну сутність оновлюємо рівно один раз за фіксований крок.
      if (entity.isDead) continue; // Пропускаємо сутності, позначені до початку кроку.
      entity.capturePrevious(); // Зберігаємо стан для інтерполяції рендеру.
      if (entity.kind === 'ship')
        entity.update(dt, this.width, this.height, input); // Корабель отримує стан клавіш.
      else entity.update(dt, this.width, this.height); // Інші сутності рухаються без клавіатури.
      if (entity.kind !== 'asteroid' && entity.kind !== 'explosion') {
        // Астероїди відбиваються, решта ігрових тіл загортаються.
        const wrapped = wrapPosition(entity.pos, this.width, this.height, entity.radius); // Рахуємо нові координати за межами.
        entity.pos = new Vector2(wrapped.x, wrapped.y); // Замінюємо позицію незмінним вектором.
      } // Завершуємо обробку меж арени.
      if (entity.kind === 'ship' && input.firePressed) entity.fire(this); // Стрільба викликає метод на кораблі, зберігаючи this.
    } // Завершуємо цикл оновлення сутностей.

    const collisions = findCircleCollisions(active, (a, b) => this.#canCollide(a, b)); // Окрема система повертає пари контактів.
    for (const [a, b] of collisions) this.#resolveCollision(a, b); // World застосовує до пар ігрові правила.
    this.#sweep(); // Видаляємо всі сутності, позначені мертвими.
  } // Завершуємо крок світу.

  // Вирішуємо, які типи сутностей можуть взаємодіяти.
  #canCollide(a: GameEntity, b: GameEntity): boolean {
    const kinds = new Set([a.kind, b.kind]); // Нормалізуємо пару, незалежно від порядку Map.
    if (kinds.has('bullet') && kinds.has('asteroid')) return true; // Кулі знищують астероїди.
    if ((a.kind === 'bullet' && b.kind === 'ship') || (a.kind === 'ship' && b.kind === 'bullet')) {
      // Кулі можуть пошкодити інші кораблі.
      const bullet = a.kind === 'bullet' ? a : b.kind === 'bullet' ? b : null; // Знаходимо кулю в парі.
      const ship = a.kind === 'ship' ? a : b; // Знаходимо корабель у парі.
      return bullet !== null && ship !== null && bullet.ownerId !== ship.id; // Власна куля не вражає стрільця.
    } // Завершуємо перевірку кулі й корабля.
    if (kinds.has('ship') && kinds.has('asteroid')) return true; // Астероїди пошкоджують корабель.
    if (kinds.has('ship') && kinds.has('pickup')) return true; // Корабель може підібрати бонус.
    return false; // Решта пар не потребує колізій.
  } // Завершуємо фільтр пар.

  // Застосовуємо шкоду, рахунок, pickup і вибухи до знайденої пари.
  #resolveCollision(a: GameEntity, b: GameEntity): void {
    if (a.isDead || b.isDead) return; // Раніше оброблена пара не може вдруге влучити.
    const bullet = a.kind === 'bullet' ? a : b.kind === 'bullet' ? b : null; // Знаходимо кулю, якщо вона є.
    const asteroid = a.kind === 'asteroid' ? a : b.kind === 'asteroid' ? b : null; // Знаходимо астероїд, якщо він є.
    const ship = a.kind === 'ship' ? a : b.kind === 'ship' ? b : null; // Знаходимо корабель, якщо він є.
    const pickup = a.kind === 'pickup' ? a : b.kind === 'pickup' ? b : null; // Знаходимо pickup, якщо він є.

    if (bullet && asteroid) {
      // Обробляємо влучання кулі в перешкоду.
      bullet.isDead = true; // Одна куля може влучити лише в перший об'єкт.
      asteroid.isDead = true; // Знищуємо астероїд після влучання.
      this.score += 10; // Додаємо десять очок за збитий астероїд.
      this.spawnExplosion(asteroid.pos.x, asteroid.pos.y); // Створюємо частинки в місці вибуху.
      emit('exploded', { x: asteroid.pos.x, y: asteroid.pos.y, score: this.score }); // Оголошуємо звук і оновлення рахунку.
      if (Math.random() < 0.2) this.spawn(new Pickup(asteroid.pos.x, asteroid.pos.y)); // Створюємо аптечку з імовірністю 20 відсотків.
      return; // Не перевіряємо інші правила для цієї пари.
    } // Завершуємо кулю й астероїд.

    if (bullet && ship) {
      // Обробляємо влучання кулі в корабель.
      bullet.isDead = true; // Позначаємо кулю використаною.
      ship.takeDamage(); // Зменшуємо приватне HP корабля.
      emit('hit', { x: ship.pos.x, y: ship.pos.y, hp: ship.hp }); // HUD і звук отримують влучання.
      if (ship.isDead) {
        this.spawnExplosion(ship.pos.x, ship.pos.y, 30);
        emit('exploded', { x: ship.pos.x, y: ship.pos.y, score: this.score });
      } // Додаємо великий вибух при знищенні.
      return; // Завершуємо обробку влучання.
    } // Завершуємо кулю й корабель.

    if (ship && asteroid) {
      // Обробляємо зіткнення корабля з астероїдом.
      asteroid.isDead = true; // Зіткнення розбиває астероїд.
      this.spawnExplosion(asteroid.pos.x, asteroid.pos.y); // Малюємо вибух на місці перешкоди.
      ship.takeDamage(); // Віднімаємо життя корабля.
      emit('hit', { x: ship.pos.x, y: ship.pos.y, hp: ship.hp }); // Сповіщаємо HUD і звук про шкоду.
      if (ship.isDead) {
        this.spawnExplosion(ship.pos.x, ship.pos.y, 30);
        emit('exploded', { x: ship.pos.x, y: ship.pos.y, score: this.score });
      } // Додаємо вибух корабля після останнього влучання.
      return; // Завершуємо обробку цієї пари.
    } // Завершуємо корабель і астероїд.

    if (ship && pickup) {
      // Обробляємо контакт корабля з pickup.
      pickup.onPickup?.(ship); // Викликаємо складену поведінку предмета.
      pickup.isDead = true; // Після підбору предмет видаляється.
    } // Завершуємо обробку pickup.
  } // Завершуємо вирішення зіткнення.

  // Прибираємо всі сутності, які загинули цього кроку.
  #sweep(): void {
    for (const [id, entity] of this.#entities) {
      // Перебираємо пари ключ-значення Map.
      if (entity.isDead) this.#entities.delete(id); // Видаляємо лише після завершення оновлень і колізій.
    } // Завершуємо безпечне очищення.
  } // Завершуємо sweep.

  // Малюємо арену й сутності в позиціях між кроками симуляції.
  render(ctx: CanvasRenderingContext2D, alpha = 1): void {
    ctx.clearRect(0, 0, this.width, this.height); // Стираємо попередній кадр.
    ctx.fillStyle = '#0b0c10'; // Задаємо темний космічний фон.
    ctx.fillRect(0, 0, this.width, this.height); // Заповнюємо все полотно фоном.
    ctx.fillStyle = 'rgba(255,255,255,0.22)'; // Задаємо приглушений колір зірок.
    for (let i = 0; i < 70; i += 1) {
      const x = (i * 137) % this.width;
      const y = (i * 83) % this.height;
      ctx.fillRect(x, y, 1, 1);
    } // Малюємо детерміноване зоряне поле.
    for (const entity of this.#entities.values()) entity.render(ctx, alpha, this.width, this.height); // Делегуємо малювання кожній сутності.
  } // Завершуємо рендер світу.
} // Завершуємо World.
