// Додаємо поведінку самонаведення до будь-якої рухомої сутності.
interface PickupEntity {
  onPickup?: (ship: Ship) => void;
}
import type { Entity } from './entity.js';
import type { Ship } from './entities.js';
import type { Vector2 } from './math.js';

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
  const direction = target.pos.sub(entity.pos).normalize(); // Обчислюємо напрямок до цілі без мутацій.
  entity.vel = entity.vel.add(direction.scale(homing.acceleration * dt)); // Плавно змінюємо швидкість у її бік.
}
