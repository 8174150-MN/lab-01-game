// Повертаємо позицію в арену, коли її центр перелетів за протилежну межу.
interface Position {
  x: number;
  y: number;
}
interface Velocity {
  x: number;
  y: number;
}

export function wrapPosition(position: Position, width: number, height: number, radius = 0): Position {
  // Створюємо новий результат, щоб не змінювати координати передані ззовні.
  return {
    x: position.x < -radius ? width + radius : position.x > width + radius ? -radius : position.x, // Загортаємо горизонтальну координату з урахуванням радіуса.
    y: position.y < -radius ? height + radius : position.y > height + radius ? -radius : position.y, // Загортаємо вертикальну координату з урахуванням радіуса.
  };
}

// Відбиваємо рухому перешкоду від меж арени та повертаємо нові значення.
export function bounceAtBounds(
  position: Position,
  velocity: Velocity,
  width: number,
  height: number,
  radius = 0,
): { position: Position; velocity: Velocity } {
  // Копіюємо координати, щоб функція не змінювала аргументи.
  let x = position.x; // Тимчасова горизонтальна координата перешкоди.
  let y = position.y; // Тимчасова вертикальна координата перешкоди.
  let vx = velocity.x; // Тимчасова горизонтальна швидкість перешкоди.
  let vy = velocity.y; // Тимчасова вертикальна швидкість перешкоди.
  // Відбиваємо перешкоду від лівої та правої меж.
  if (x < radius || x > width - radius) vx *= -1; // Змінюємо напрямок лише при контакті з горизонтальною стіною.
  // Відбиваємо перешкоду від верхньої та нижньої меж.
  if (y < radius || y > height - radius) vy *= -1; // Змінюємо напрямок лише при контакті з вертикальною стіною.
  // Повертаємо координати в межі, щоб уникнути повторного відбивання.
  x = Math.max(radius, Math.min(width - radius, x)); // Обмежуємо координату X межами арени.
  y = Math.max(radius, Math.min(height - radius, y)); // Обмежуємо координату Y межами арени.
  // Віддаємо позицію й швидкість одним новим об'єктом.
  return { position: { x, y }, velocity: { x: vx, y: vy } }; // Повертаємо відбитий стан.
}
