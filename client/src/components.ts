// Додаємо поведінку самонаведення до будь-якої рухомої сутності.
interface PickupEntity {
  onPickup?: (ship: Ship) => void;
}
import type { Entity } from './entity.js';
import type { Ship } from './entities.js';

export function withHoming<T extends Entity>(entity: T, target: Entity, acceleration: number): T {
  entity.homing = { target, acceleration }; // Компонент зберігає ціль і силу повороту траєкторії.
  return entity; // Повертаємо ту саму сутність після додавання компонента.
} // Завершуємо компонент самонаведення.

// Додаємо підбір будь-якому об'єкту без створення глибокої ієрархії класів.
export function withPickup<T extends PickupEntity>(entity: T, onPickup: (ship: Ship) => void): T {
  entity.onPickup = onPickup; // Система зіткнень викликає цю функцію при контакті.
  return entity; // Повертаємо сутність з додатковою поведінкою.
} // Завершуємо компонент pickup.

// Керуємо будь-якою сутністю з компонентом homing у базовому update.
export function steerTowardTarget(entity: Entity, dt: number): void {
  const homing = entity.homing;
  const target = homing?.target; // Читаємо ціль, якщо компонент додано.
  if (!target || target.isDead) return; // Не переслідуємо відсутню або знищену ціль.
  const dx = target.pos.x - entity.pos.x; // Знаходимо горизонтальну різницю без створення Vector2.
  const dy = target.pos.y - entity.pos.y; // Знаходимо вертикальну різницю без створення Vector2.
  const distance = Math.hypot(dx, dy); // Обчислюємо довжину напрямку до цілі.
  if (distance === 0) return; // Не ділимо на нуль, якщо об'єкти займають ту саму точку.
  const strength = (homing.acceleration * dt) / distance; // Нормалізуємо напрямок і множимо на прискорення.
  entity.vel.set(entity.vel.x + dx * strength, entity.vel.y + dy * strength); // Оновлюємо наявний вектор швидкості.
}
