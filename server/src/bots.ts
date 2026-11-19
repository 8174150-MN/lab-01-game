import { ARENA_HEIGHT, ARENA_WIDTH, wrappedDelta } from '@dogfight/shared/engine'; // Користуємося тими самими межами арени, що й фізика гри.
import type { AsteroidEntity, InputCommand, Seq, ShipState } from '@dogfight/shared/types'; // Бот отримує стан та повертає звичайну команду гравця.

export interface PlayerInput {
  next(ship: ShipState, opponents: readonly ShipState[], asteroids: readonly AsteroidEntity[], seq: Seq): InputCommand;
} // Описуємо спільний контракт input для людини й автоматичного гравця.

export class Bot implements PlayerInput {
  next(ship: ShipState, opponents: readonly ShipState[], asteroids: readonly AsteroidEntity[], seq: Seq): InputCommand {
    let targetX = ship.x + Math.cos(ship.angle) * 100; // Якщо цілей нема, бот продовжує рух уперед.
    let targetY = ship.y + Math.sin(ship.angle) * 100; // Початковий напрямок не створює випадкового стану.
    let targetDistance = Number.POSITIVE_INFINITY; // Шукаємо найближчу ціль з урахуванням країв арени.
    let isEnemy = false; // Розрізняємо корабель і астероїд лише для вибору часу пострілу.

    for (const opponent of opponents) {
      if (opponent === ship || opponent.hp <= 0) continue; // Пропускаємо власний стан і корабель, що очікує респауну.
      const dx = wrappedDelta(ship.x, opponent.x, ARENA_WIDTH); // Рахуємо найкоротший напрямок крізь межу арени.
      const dy = wrappedDelta(ship.y, opponent.y, ARENA_HEIGHT); // Такий самий розрахунок виконуємо для вертикалі.
      const distance = dx * dx + dy * dy; // Квадрат відстані не потребує повільного кореня.
      if (distance >= targetDistance) continue; // Залишаємо попередню ціль, якщо вона ближча.
      targetDistance = distance; // Запам'ятовуємо відстань до нового найближчого ворога.
      targetX = ship.x + dx; // Ставимо точку цілі у найближчій копії арени.
      targetY = ship.y + dy; // Вертикаль цілі відповідає shortest wrapped path.
      isEnemy = true; // Корабель можна атакувати пострілом.
    } // Завершуємо пошук найближчого корабля.

    let evadeX = 0; // Небезпека астероїда відштовхує корабель.
    let evadeY = 0; // Відхилення накопичується, якщо астероїди поруч.
    for (const asteroid of asteroids) {
      const dx = wrappedDelta(ship.x, asteroid.x, ARENA_WIDTH); // Визначаємо напрямок до перешкоди.
      const dy = wrappedDelta(ship.y, asteroid.y, ARENA_HEIGHT); // Враховуємо загортання арени.
      const distance = Math.hypot(dx, dy); // Для радіуса небезпечної зони потрібна звичайна відстань.
      const dangerRadius = asteroid.radius + 65; // Починаємо маневр до зіткнення.
      if (distance >= dangerRadius || distance === 0) continue; // Далека перешкода не змінює керування.
      const strength = (dangerRadius - distance) / dangerRadius; // Ближча перешкода сильніше відштовхує.
      evadeX -= (dx / distance) * strength; // Відштовхуємося від астероїда по горизонталі.
      evadeY -= (dy / distance) * strength; // Відштовхуємося від астероїда по вертикалі.
    } // Завершуємо оцінку сусідніх перешкод.

    if (evadeX !== 0 || evadeY !== 0) {
      targetX = ship.x + evadeX * 100; // Коли поруч небезпека, ціль стає напрямком утечі.
      targetY = ship.y + evadeY * 100; // Уникаємо найближчих астероїдів перед погонею.
      isEnemy = false; // Під час маневру ухилення не вимагаємо точного пострілу.
    } // Застосовуємо уникнення зіткнень.

    const desiredAngle = Math.atan2(targetY - ship.y, targetX - ship.x); // Напрямок руху до цілі або від небезпеки.
    const angleDifference = Math.atan2(Math.sin(desiredAngle - ship.angle), Math.cos(desiredAngle - ship.angle)); // Зводимо різницю кутів до найкоротшого повороту.
    const turn: -1 | 0 | 1 = angleDifference > 0.08 ? 1 : angleDifference < -0.08 ? -1 : 0; // Повертаємо тим самим трьохзначним input, що надсилає людина.
    const shouldShoot = isEnemy && Math.abs(angleDifference) < 0.22 && (seq % 6 === 0 || targetDistance < 140 * 140); // Стріляємо по ворогу лише коли корабель приблизно наведений.
    return { seq, gas: true, turn, shoot: shouldShoot }; // Повертаємо звичайну команду симуляції, а не змінюємо координати напряму.
  } // Завершуємо вибір одного input на крок сервера.
} // Завершуємо AI бота.
