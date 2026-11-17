// Додаємо поведінку самонаведення до будь-якої рухомої сутності.
export function withHoming(entity, target, acceleration) {
  entity.homing = { target, acceleration }; // Компонент зберігає ціль і силу повороту траєкторії.
  return entity; // Повертаємо ту саму сутність після додавання компонента.
} // Завершуємо компонент самонаведення.

// Додаємо підбір будь-якому об'єкту без створення глибокої ієрархії класів.
export function withPickup(entity, onPickup) {
  entity.onPickup = onPickup; // Система зіткнень викликає цю функцію при контакті.
  return entity; // Повертаємо сутність з додатковою поведінкою.
} // Завершуємо компонент pickup.

// Керуємо будь-якою сутністю з компонентом homing у базовому update.
export function steerTowardTarget(entity, dt) {
  const target = entity.homing?.target; // Читаємо ціль, якщо компонент додано.
  if (!target || target.isDead) return; // Не переслідуємо відсутню або знищену ціль.
  const direction = target.pos.sub(entity.pos).normalize(); // Обчислюємо напрямок до цілі без мутацій.
  entity.vel = entity.vel.add(direction.scale(entity.homing.acceleration * dt)); // Плавно змінюємо швидкість у її бік.
}
