import * as fc from 'fast-check'; // Генератор створює багато різних вхідних значень.
import { describe, expect, it } from 'vitest'; // Vitest виконує перевірки спільного коду.
import {
  ARENA_HEIGHT,
  ARENA_WIDTH,
  FIXED_DT,
  createAsteroidState,
  createBullet,
  createPickupState,
  createShipState,
  reconcilePrediction,
  integrate,
  integrateBulletInto,
  integrateInto,
  integrateAsteroid,
  integrateBullet,
  interpolateAngle,
  nextRandom,
  normalizeAngle,
  wrapCoordinate,
  wrappedDelta,
} from '../engine.js'; // Імпортуємо спільні правила руху.
import { Vector2 } from '../vector.js'; // Імпортуємо вектор із незмінними координатами.
import { asEntityId, asSeq, asTick, type Snapshot } from '../types.js'; // Створюємо branded-значення для знімка.
import {
  deserializeInput,
  deserializeSnapshot,
  parseClientMessage,
  serializeInput,
  serializeSnapshot,
} from '../protocol.js'; // Перевіряємо мережеве кодування.

describe('Vector2 across representative values', () => {
  const cases = Array.from({ length: 24 }, (_, index) => index - 12); // Включаємо від'ємні числа, нуль і додатні значення.

  for (const value of cases) {
    it('keeps vector operations correct for ' + value, () => {
      const original = new Vector2(value, -value); // Зберігаємо початковий вектор для перевірки чистоти.
      const other = new Vector2(2, 3); // Додаємо постійний вектор для порівняння.
      expect(original.add(other)).toEqual(new Vector2(value + 2, -value + 3)); // Перевіряємо додавання.
      expect(original.sub(other)).toEqual(new Vector2(value - 2, -value - 3)); // Перевіряємо віднімання.
      expect(original.scale(2)).toEqual(new Vector2(value * 2, -value * 2)); // Перевіряємо множення на скаляр.
      expect(original).toEqual(new Vector2(value, -value)); // Переконуємося, що методи не змінили аргумент.
    }); // Завершуємо одну параметризовану перевірку вектора.
  } // Запускаємо окремий тест для кожного значення.

  it('covers vector length, normalization, rotation, dot, distance, and angle construction', () => {
    const vector = new Vector2(3, 4); // Використовуємо вектор із відомою довжиною.
    expect(vector.length()).toBe(5); // Довжина є гіпотенузою трикутника 3-4-5.
    expect(vector.magnitude()).toBe(5); // Аліас magnitude повертає ту саму довжину.
    const normalized = vector.normalize(); // Обчислюємо результат нормалізації.
    expect(normalized.x).toBeCloseTo(0.6, 8); // Нормалізований X має допустиму точність чисел з рухомою комою.
    expect(normalized.y).toBeCloseTo(0.8, 8); // Нормалізований Y має допустиму точність чисел з рухомою комою.
    expect(new Vector2().normalize()).toEqual(new Vector2()); // Нульовий вектор не ділиться на нуль.
    expect(vector.rotate(Math.PI / 2).x).toBeCloseTo(-4, 8); // Поворот на 90° переносить X у -Y.
    expect(vector.rotate(Math.PI / 2).y).toBeCloseTo(3, 8); // Поворот на 90° переносить Y у X.
    expect(vector.dot(new Vector2(1, 2))).toBe(11); // Скалярний добуток дорівнює 3×1 + 4×2.
    expect(vector.dist(new Vector2(0, 0))).toBe(5); // Відстань до початку координат дорівнює довжині.
    expect(Vector2.fromAngle(0)).toEqual(new Vector2(1, 0)); // Нульовий кут спрямований уздовж X.
  }); // Завершуємо перевірку решти методів Vector2.
}); // Завершуємо векторні перевірки.

describe('fixed-step protocol properties', () => {
  it('reuses caller-owned motion buffers with the same fixed-step result', () => {
    const ship = createShipState(350, 240); // Фіксуємо стан до локального передбачення.
    const shipOutput = { x: 0, y: 0, vx: 0, vy: 0, angle: 0 }; // Один буфер можна тримати між кадрами.
    const shipResult = integrateInto(ship, { gas: true, turn: 1 }, 1 / 60, shipOutput); // Перераховуємо стан без нової алокації.
    const expectedShip = integrate(ship, { gas: true, turn: 1 }, 1 / 60); // Еталон лишається чистою функцією.
    expect(shipResult).toBe(shipOutput); // Допоміжна функція повертає той самий буфер.
    expect(shipOutput).toEqual({
      x: expectedShip.x,
      y: expectedShip.y,
      vx: expectedShip.vx,
      vy: expectedShip.vy,
      angle: expectedShip.angle,
    }); // Обидва шляхи рахують однакову фізику.
    expect(ship.x).toBe(350); // Вхідний стан не змінився.
    const bullet = createBullet(ship, asEntityId('pilot'), asSeq(1)); // Створюємо один прогнозований постріл.
    const bulletOutput = { x: 0, y: 0, vx: 0, vy: 0, ttl: 0 }; // Буфер кулі теж створюється лише один раз.
    const bulletResult = integrateBulletInto(bullet, 1 / 60, bulletOutput); // Застосовуємо той самий фіксований крок.
    const expectedBullet = integrateBullet(bullet, 1 / 60); // Перевіряємо проти чистого результату.
    expect(bulletResult).toBe(bulletOutput); // Куля оновила надану пам'ять.
    expect(bulletOutput).toEqual({
      x: expectedBullet.x,
      y: expectedBullet.y,
      vx: expectedBullet.vx,
      vy: expectedBullet.vy,
      ttl: expectedBullet.ttl,
    }); // Позиція, швидкість і TTL збігаються.
  }); // Завершуємо перевірку рендер-буферів.

  it('reconciles an authoritative state without changing it or the pending inputs', () => {
    const authoritative = { ...createShipState(350, 240), ackSeq: asSeq(1) }; // Сервер уже застосував першу команду.
    const acknowledged = { seq: asSeq(1), gas: false, turn: 1 as const, shoot: false }; // Цю команду повторювати не потрібно.
    const pending = { seq: asSeq(2), gas: true, turn: 0 as const, shoot: false }; // Цю команду клієнт має програти повторно.
    const history = [acknowledged, pending]; // Черга передається функції лише для читання.
    const result = reconcilePrediction(authoritative, history); // Відновлюємо стан чистим обчисленням.
    expect(result).toEqual(integrate(authoritative, pending, FIXED_DT)); // Результат містить лише непідтверджений рух.
    expect(authoritative.x).toBe(350); // Початковий серверний об'єкт не змінився.
    expect(history).toEqual([acknowledged, pending]); // Початкова черга команд не змінилася.
  }); // Завершуємо тест чистої reconciliation-функції.

  it('restores a snapshot with the documented angle rounding', () => {
    fc.assert(
      fc.property(fc.double({ min: -3.14, max: 3.14, noNaN: true }), (angle) => {
        const snapshot: Snapshot = {
          v: 3,
          type: 'snapshot',
          tick: asTick(42),
          seed: 7,
          players: [
            {
              kind: 'ship',
              id: asEntityId('pilot-1'),
              name: 'Pilot',
              x: 120,
              y: 240,
              vx: 3.5,
              vy: -2.25,
              angle,
              hp: 3,
              ackSeq: asSeq(9),
              respawnTicks: 0,
              score: 10,
            },
          ],
          bullets: [],
          asteroids: [],
          pickups: [],
        }; // Створюємо знімок з кутом, який зберігається в Int16 з масштабом 10000.
        const decoded = deserializeSnapshot(serializeSnapshot(snapshot)); // Кодуємо та відразу декодуємо бінарний кадр.
        const roundedAngle = Math.round(angle * 10000) / 10000; // Обчислюємо кут, округлений до одиниць Int16.
        expect(decoded.players[0]?.angle).toBe(roundedAngle === 0 ? 0 : roundedAngle); // Протокол нормалізує мінус-нуль до звичайного нуля.
        expect(decoded.players[0]?.x).toBe(snapshot.players[0]?.x); // Інші поля стану залишаються незмінними.
      }),
      { numRuns: 120 },
    ); // Перевіряємо багато випадкових кутів без фіксованого прикладу.
  }); // Завершуємо властивість round-trip.

  it('matches binary frame length to every encoded record', () => {
    fc.assert(
      fc.property(
        fc.record({
          players: fc.integer({ min: 0, max: 4 }),
          bullets: fc.integer({ min: 0, max: 4 }),
          asteroids: fc.integer({ min: 0, max: 4 }),
          pickups: fc.integer({ min: 0, max: 4 }),
        }),
        (counts) => {
          const players = Array.from({ length: counts.players }, (_, index) => ({
            kind: 'ship' as const,
            id: asEntityId('p' + index),
            name: 'Pilot ' + index,
            x: index,
            y: index + 1,
            vx: 0,
            vy: 0,
            angle: 0,
            hp: 3,
            ackSeq: asSeq(index),
            respawnTicks: 0,
            score: 0,
          })); // Створюємо стільки кораблів, скільки згенерував генератор.
          const bullets = Array.from({ length: counts.bullets }, (_, index) => ({
            kind: 'bullet' as const,
            id: asEntityId('b' + index),
            ownerId: asEntityId('owner'),
            x: 0,
            y: 0,
            vx: 0,
            vy: 0,
            ttl: 1,
          })); // Створюємо тестові записи куль.
          const asteroids = Array.from({ length: counts.asteroids }, (_, index) => ({
            kind: 'asteroid' as const,
            id: asEntityId('a' + index),
            x: 0,
            y: 0,
            vx: 0,
            vy: 0,
            radius: 20,
            homing: false,
          })); // Створюємо тестові записи астероїдів.
          const pickups = Array.from({ length: counts.pickups }, (_, index) => ({
            kind: 'pickup' as const,
            id: asEntityId('u' + index),
            x: 0,
            y: 0,
            radius: 8,
          })); // Створюємо тестові записи бонусів.
          const snapshot: Snapshot = {
            v: 3,
            type: 'snapshot',
            tick: asTick(1),
            seed: 1,
            players,
            bullets,
            asteroids,
            pickups,
          }; // Складаємо повний пакет протоколу.
          const stringBytes = (value: string) => new TextEncoder().encode(value).byteLength + 1; // Рахуємо UTF-8 рядок і його байт довжини.
          const expected =
            14 +
            players.reduce((sum, player) => sum + stringBytes(player.id) + stringBytes(player.name) + 27, 0) +
            bullets.reduce((sum, bullet) => sum + stringBytes(bullet.id) + stringBytes(bullet.ownerId) + 18, 0) +
            asteroids.reduce((sum, asteroid) => sum + stringBytes(asteroid.id) + 21, 0) +
            pickups.reduce((sum, pickup) => sum + stringBytes(pickup.id) + 12, 0); // Підраховуємо заголовок і розмір запису кожного kind.
          expect(serializeSnapshot(snapshot).byteLength).toBe(expected); // Розмір кадру збігається з описом формату.
        },
      ),
      { numRuns: 80 },
    ); // Генеруємо різні поєднання кількості сутностей.
  }); // Завершуємо властивість довжини кадру.

  it('rejects malformed byte buffers with a catchable error', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 128 }), (source) => {
        const bytes = Uint8Array.from(source); // Копіюємо довільні байти, щоб не змінювати генератор.
        if (bytes.length > 0) bytes[0] = 255; // Зіпсована версія гарантовано не відповідає протоколу.
        expect(() => deserializeSnapshot(bytes)).toThrow(); // Декодер відхиляє пакет винятком, який можна обробити.
      }),
      { numRuns: 100 },
    ); // Перевіряємо буфери різної довжини й вмісту.
  }); // Завершуємо властивість некоректного буфера.

  it('keeps the ship inside the arena after every fixed step', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: ARENA_WIDTH, noNaN: true }),
        fc.double({ min: 0, max: ARENA_HEIGHT, noNaN: true }),
        fc.boolean(),
        fc.constantFrom(-1, 0, 1),
        (x, y, gas, turn) => {
          const next = integrate(createShipState(x, y), { gas, turn }, 0.25); // Проводимо корабель одним довгим, але допустимим кроком.
          expect(next.x).toBeGreaterThanOrEqual(0); // Координата X не перетнула лівий край.
          expect(next.x).toBeLessThan(ARENA_WIDTH); // Координата X загорнулася до правої межі.
          expect(next.y).toBeGreaterThanOrEqual(0); // Координата Y не перетнула верхній край.
          expect(next.y).toBeLessThan(ARENA_HEIGHT); // Координата Y загорнулася до нижньої межі.
        },
      ),
      { numRuns: 120 },
    ); // Перевіряємо крайні й звичайні початкові координати.
  }); // Завершуємо властивість меж арени.

  it('accepts valid joins and rejects messages with extra fields', () => {
    const text = fc.string({ minLength: 1, maxLength: 20 }).filter((value) => value.trim().length > 0); // Генеруємо непорожні назви після trim.
    fc.assert(
      fc.property(text, text, (room, name) => {
        const valid = parseClientMessage(JSON.stringify({ v: 1, type: 'join', room, name })); // Формуємо коректний join-пакет.
        const invalid = parseClientMessage(JSON.stringify({ v: 1, type: 'join', room, name, coordinates: [1, 2] })); // Додаємо заборонені координати.
        expect(valid.ok).toBe(true); // Дозволені поля приймаються Zod-схемою.
        expect(invalid.ok).toBe(false); // Сувора схема відхиляє пошкоджену форму.
      }),
      { numRuns: 100 },
    ); // Перевіряємо довільні імена й кімнати.
  }); // Завершуємо властивість runtime-розбору.

  it('round-trips every valid input flag combination', () => {
    const inputs = Array.from({ length: 24 }, (_, index) => ({
      seq: asSeq(index),
      gas: index % 2 === 0,
      turn: ((index % 3) - 1) as -1 | 0 | 1,
      shoot: index % 4 === 0,
    })); // Перебираємо різні комбінації input.
    for (const input of inputs) expect(deserializeInput(serializeInput(input))).toEqual(input); // Перевіряємо кожну команду через DataView.
  }); // Завершуємо точкові перевірки input.
}); // Завершуємо властивості спільного протоколу та симуляції.

describe('deterministic integration cases', () => {
  for (let index = 0; index < 16; index += 1) {
    it('replays the same input sequence ' + index, () => {
      const initial = createShipState(index * 17, index * 11); // Задаємо різний початок у межах арени.
      const run = () => {
        let state = initial; // Починаємо кожний прогін з того самого стану.
        for (let tick = 0; tick < 120; tick += 1)
          state = integrate(state, { gas: tick % 2 === 0, turn: ((tick % 3) - 1) as -1 | 0 | 1 }); // Подаємо фіксовану послідовність керувань.
        return state; // Повертаємо кінцевий стан для порівняння.
      };
      expect(run()).toEqual(run()); // Однаковий input відтворює той самий результат.
    }); // Завершуємо окремий повторюваний сценарій.
  } // Вимірюємо детермінізм на різних стартових позиціях.
}); // Завершуємо тести фіксованого кроку.

describe('shared movement helpers', () => {
  it('normalizes positive and negative angles and wraps either side of the arena', () => {
    expect(normalizeAngle(Math.PI * 3)).toBeCloseTo(Math.PI, 8); // Кут за межами діапазону приводиться до π.
    expect(normalizeAngle(-Math.PI * 3)).toBeCloseTo(-Math.PI, 8); // Від'ємний кут приводиться до -π.
    expect(wrapCoordinate(-1, 100)).toBe(99); // Виліт за лівий край з'являється справа.
    expect(wrapCoordinate(101, 100)).toBe(1); // Виліт за правий край з'являється зліва.
  }); // Завершуємо граничні перевірки кута й координати.

  it('creates and advances a bullet until its TTL expires', () => {
    const owner = asEntityId('pilot'); // Задаємо перевірений ID стрільця.
    const shot = createBullet(createShipState(100, 100, 0), owner, asSeq(12)); // Створюємо постріл із передбачуваною послідовністю.
    expect(shot.id).toBe('pilot:12'); // ID пов'язує кулю з відправленим input.
    expect(shot.ownerId).toBe(owner); // Куля зберігає власника.
    const moved = integrateBullet(shot, 0.1); // Просуваємо її на одну десяту секунди.
    expect(moved.x).toBeGreaterThan(shot.x); // Куля летить у напрямку носа.
    expect(moved.dead).toBe(false); // TTL ще не закінчився.
    expect(integrateBullet(shot, 2).dead).toBe(true); // Достатньо довгий крок позначає кулю мертвою.
  }); // Завершуємо перевірку кулі.

  it('moves and reflects an asteroid at all four sides', () => {
    const id = asEntityId('rock'); // Задаємо ID перешкоди.
    const cases = [
      createAsteroidState(id, 5, 100, -10, 0, 10), // Стан біля лівої межі.
      createAsteroidState(id, ARENA_WIDTH - 5, 100, 10, 0, 10), // Стан біля правої межі.
      createAsteroidState(id, 100, 5, 0, -10, 10), // Стан біля верхньої межі.
      createAsteroidState(id, 100, ARENA_HEIGHT - 5, 0, 10, 10), // Стан біля нижньої межі.
    ]; // Готуємо по одному тесту на кожну стіну.
    const reflected = cases.map((asteroid) => integrateAsteroid(asteroid, 0.1)); // Інтегруємо астероїди у напрямку за межі.
    expect(reflected[0]?.vx).toBeGreaterThan(0); // Ліва стіна розвернула швидкість вправо.
    expect(reflected[1]?.vx).toBeLessThan(0); // Права стіна розвернула швидкість вліво.
    expect(reflected[2]?.vy).toBeGreaterThan(0); // Верхня стіна розвернула швидкість вниз.
    expect(reflected[3]?.vy).toBeLessThan(0); // Нижня стіна розвернула швидкість угору.
    expect(createPickupState(id, 2, 3).radius).toBe(8); // Pickup отримує стандартний радіус.
  }); // Завершуємо перевірку відбиття.

  it('keeps seeded randomness and wrapped interpolation deterministic', () => {
    expect(nextRandom(1234)).toEqual(nextRandom(1234)); // Той самий seed дає той самий результат.
    expect(nextRandom(1234).value).toBeGreaterThanOrEqual(0); // Випадкове число не менше нуля.
    expect(nextRandom(1234).value).toBeLessThan(1); // Випадкове число менше одиниці.
    expect(wrappedDelta(0, 90, 100)).toBe(-10); // Найкоротший шлях перетинає правий край.
    expect(wrappedDelta(90, 0, 100)).toBe(10); // Зворотний шлях перетинає лівий край.
    expect(wrappedDelta(10, 20, 100)).toBe(10); // Координати всередині арени лишаються без змін.
    expect(Math.abs(interpolateAngle(Math.PI - 0.1, -Math.PI + 0.1, 0.5))).toBeCloseTo(Math.PI, 1); // Кут іде коротким шляхом біля π.
  }); // Завершуємо перевірку повторюваного seed і інтерполяції.
}); // Завершуємо додаткові чисті функції симуляції.
