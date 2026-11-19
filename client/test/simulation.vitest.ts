import { describe, expect, it, vi } from 'vitest'; // Vitest групує тести й керує фіктивними таймерами.
import { interpolateAngle, integrate } from '../src/sim/physics.js'; // Тестуємо чисту фізику корабля.
import { bounceAtBounds, wrapPosition } from '../src/sim/arena.js'; // Тестуємо межі арени окремо від DOM.
import { circlesOverlap, findCircleCollisions } from '../src/sim/collision.js'; // Перевіряємо систему кола-коло.
import { createLoop } from '../src/loop.js'; // Перевіряємо цикл із фіксованим кроком.
import { Asteroid, Explosion } from '../src/entities.js'; // Перевіряємо повторне використання сутностей у грі.
import { World } from '../src/world.js'; // Запускаємо справжній крок локального світу.
import { fillBotInputs } from '../src/diagnostics/bot-input-work.js'; // Перевіряємо чисте формування input для worker експерименту.

describe('client ship integration cases', () => {
  for (let index = 0; index < 24; index += 1) {
    it('keeps a finite state in case ' + index, () => {
      const ship = { x: 20 + index * 3, y: 30 + index * 2, vx: index - 12, vy: 12 - index, angle: index / 10 }; // Готуємо різні швидкості й напрямки.
      const input = { thrust: index % 2 === 0, left: index % 3 === 0, right: index % 3 === 1 }; // Перебираємо різні натискання клавіш.
      const next = integrate(ship, input, 1 / 60); // Виконуємо один фіксований крок клієнтської фізики.
      expect(next).not.toBe(ship); // Фізика повертає окремий стан.
      expect([next.x, next.y, next.vx, next.vy, next.angle].every(Number.isFinite)).toBe(true); // Усі числові компоненти залишаються скінченними.
      expect(ship.x).toBe(20 + index * 3); // Початковий стан не змінюється.
    }); // Завершуємо перевірку одного стану корабля.
  } // Запускаємо набір на різних векторах швидкості.
}); // Завершуємо перевірки руху корабля.

describe('arena and circle boundaries', () => {
  for (let index = 1; index <= 20; index += 1) {
    it('wraps and bounces a radius-five body in case ' + index, () => {
      const wrapped = wrapPosition({ x: index * 37 - 400, y: index * 31 + 500 }, 320, 240, 5); // Заводимо точку за межі арени в обох напрямках.
      expect(wrapped.x).toBeGreaterThanOrEqual(-5); // Межа враховує радіус тіла, що загортається.
      expect(wrapped.x).toBeLessThanOrEqual(325); // Виліт за правий край переходить на протилежний бік.
      expect(wrapped.y).toBeGreaterThanOrEqual(-5); // Межа враховує радіус по вертикалі.
      expect(wrapped.y).toBeLessThanOrEqual(245); // Виліт за нижній край переходить на верхній.
      const bounced = bounceAtBounds({ x: 2, y: 120 }, { x: -index, y: 0 }, 320, 240, 5); // Перевіряємо удар об ліву стіну.
      expect(bounced.position.x).toBe(5); // Центр тіла повернувся всередину межі.
      expect(bounced.velocity.x).toBe(index); // Горизонтальна швидкість змінила напрямок.
    }); // Завершуємо перевірку меж одного випадку.
  } // Перевіряємо набір швидкостей.

  for (let index = 0; index < 16; index += 1) {
    it('reports circle contact consistently for radius case ' + index, () => {
      const first = { pos: { x: 0, y: 0 }, radius: 10 + index, isDead: false }; // Розмір першого кола змінюється.
      const touching = { pos: { x: 20 + index, y: 0 }, radius: 10, isDead: false }; // Друге коло торкається першого.
      const distant = { pos: { x: 500, y: 500 }, radius: 10, isDead: false }; // Третє коло точно далеко.
      expect(circlesOverlap(first, touching)).toBe(true); // Дотик радіусів вважається колізією.
      expect(circlesOverlap(first, distant)).toBe(false); // Віддалені кола не перетинаються.
      expect(findCircleCollisions([first, touching, distant])).toHaveLength(1); // Система повертає лише одну пару.
    }); // Завершуємо один набір перевірок геометрії.
  } // Перевіряємо різні радіуси кіл.

  for (let index = 0; index < 12; index += 1) {
    it('interpolates the short angular path in case ' + index, () => {
      const from = Math.PI - 0.02 - index * 0.001; // Починаємо трохи до переходу через π.
      const to = -Math.PI + 0.02 + index * 0.001; // Закінчуємо трохи після переходу.
      const midpoint = interpolateAngle(from, to, 0.5); // Беремо половину короткого кутового шляху.
      expect(Math.abs(Math.abs(midpoint) - Math.PI)).toBeLessThan(0.05); // Кут не перетинає весь екран через нуль.
    }); // Завершуємо перевірку інтерполяції кута.
  } // Перевіряємо кілька значень біля межі.
}); // Завершуємо перевірки арени й колізій.

describe('allocation pools and reusable frame state', () => {
  it('keeps asteroid position and velocity vectors across simulation steps', () => {
    const world = new World(320, 240); // Створюємо невелику тестову арену.
    const asteroid = world.spawn(new Asteroid(100, 100)); // Додаємо одну сутність із рухом.
    const position = asteroid.pos; // Зберігаємо посилання на її вектор позиції.
    const velocity = asteroid.vel; // Зберігаємо посилання на її вектор швидкості.
    world.step(1 / 60); // Оновлюємо симуляцію один раз.
    expect(asteroid.pos).toBe(position); // Крок не створив новий вектор позиції.
    expect(asteroid.vel).toBe(velocity); // Крок не створив новий вектор швидкості.
  }); // Завершуємо перевірку гарячої ділянки кадру.

  it('reuses a bullet object with a fresh entity id', () => {
    const world = new World(320, 240); // Пул належить конкретному ігровому світу.
    const first = world.spawnBullet(20, 20, 0, { x: 0, y: 0 }, 1); // Створюємо першу кулю.
    const firstId = first.id; // Запам'ятовуємо ID першого життя кулі.
    world.despawn(firstId); // Позначаємо кулю для відкладеного видалення.
    world.step(1 / 60); // Sweep прибирає кулю і повертає її у пул.
    const second = world.spawnBullet(40, 40, Math.PI / 2, { x: 2, y: 0 }, 2); // Беремо екземпляр для нового пострілу.
    expect(second).toBe(first); // Об'єкт у пам'яті той самий.
    expect(second.id).not.toBe(firstId); // Нове життя отримало окремий ID.
    expect(second.ownerId).toBe(2); // Власник належить другому пострілу.
    expect(second.ttl).toBe(1.5); // Таймер життя скинуто.
  }); // Завершуємо перевірку пулу куль.

  it('returns expired particles to the pool for the next explosion', () => {
    const firstExplosion = new Explosion(60, 70, 1); // Створюємо один короткий ефект.
    const particle = firstExplosion.particles[0]; // Зберігаємо посилання на його частинку.
    expect(particle).toBeDefined(); // Конструктор справді створив частинку.
    if (!particle) return; // Зупиняємо тест типобезпечним способом у разі регресії.
    const firstId = particle.id; // Запам'ятовуємо ID першого використання.
    firstExplosion.update(1, 320, 240); // Промотуємо час за межі життя частинки.
    const secondExplosion = new Explosion(120, 130, 1); // Створюємо наступний ефект після завершення першого.
    expect(secondExplosion.particles[0]).toBe(particle); // Пул повернув той самий об'єкт.
    expect(particle.id).not.toBe(firstId); // Повторне використання отримало новий ID.
    expect(particle.isDead).toBe(false); // Частинка активна для нового ефекту.
  }); // Завершуємо перевірку пулу частинок.
}); // Завершуємо перевірки повторного використання.

it('uses a fixed simulation step when rAF is driven by fake timers', async () => {
  vi.useFakeTimers(); // Перемикаємо setTimeout на контрольований тестовий годинник.
  let now = 0; // Задаємо монотонну часову мітку для кадрового callback.
  const steps: number[] = []; // Збираємо dt фізичних кроків.
  const alphas: number[] = []; // Збираємо значення інтерполяції рендеру.
  const loop = createLoop({
    step: 1 / 60,
    simulate: (dt) => steps.push(dt),
    render: (alpha) => alphas.push(alpha),
    requestFrame: (callback) =>
      Number(
        setTimeout(() => {
          now += 16;
          callback(now);
        }, 16),
      ), // Підміняємо rAF фіктивним таймером із timestamp.
    cancelFrame: (handle) => clearTimeout(handle), // Зупинка циклу скасовує активний тестовий таймер.
  }); // Створюємо той самий цикл, що виконується у браузері.
  try {
    loop.start(); // Плануємо перший кадр.
    await vi.advanceTimersByTimeAsync(160); // Проганяємо десять фіктивних кадрів.
    loop.stop(); // Зупиняємо наступний таймер після вимірювання.
    expect(steps.length).toBeGreaterThan(0); // Акумулятор виконав симуляційні кроки.
    expect(steps.every((dt) => dt === 1 / 60)).toBe(true); // Фізика отримала сталий крок.
    expect(alphas.every((alpha) => alpha >= 0 && alpha < 1)).toBe(true); // Рендер отримав коректну частку інтерполяції.
  } finally {
    loop.stop(); // Гарантовано прибираємо запланований таймер.
    vi.useRealTimers(); // Повертаємо звичайний годинник іншим тестам.
  } // Завершуємо керований цикл.
}); // Завершуємо тест rAF із fake timers.

it('builds repeatable gas, turn, and shoot inputs for each bot', () => {
  const inputs = new Uint8Array(3 * 3); // Виділяємо три поля для кожного з трьох кроків одного бота.
  fillBotInputs(inputs, 1, 3); // Запускаємо детермінований генератор без Worker або DOM.
  expect([...inputs]).toEqual([1, 0, 1, 0, 1, 0, 0, 2, 0]); // Перевіряємо закодовані gas, turn і shoot.
}); // Завершуємо тест генератора ботів.
