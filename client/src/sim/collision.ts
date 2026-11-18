// Перевіряємо два кола без прив'язки до класів або DOM.
interface CircleEntity {
  readonly pos: { readonly x: number; readonly y: number };
  readonly radius: number;
  readonly isDead: boolean;
}

export function circlesOverlap(a: CircleEntity, b: CircleEntity): boolean {
  // Рахуємо різницю координат центрів кіл.
  const dx = a.pos.x - b.pos.x; // Горизонтальна відстань зі знаком.
  const dy = a.pos.y - b.pos.y; // Вертикальна відстань зі знаком.
  // Складаємо радіуси, щоб отримати найбільшу відстань між центрами при контакті.
  const radii = a.radius + b.radius; // Сума радіусів двох об'єктів.
  // Порівняння квадратів не потребує повільного квадратного кореня.
  return dx * dx + dy * dy <= radii * radii; // Повертаємо true, якщо кола торкаються або перетинаються.
}

// Формуємо список пар зіткнень; World вирішує, що робити з кожною парою.
export function findCircleCollisions<T extends CircleEntity>(
  entities: readonly T[],
  canCollide: (a: T, b: T) => boolean = () => true,
): [T, T][] {
  // Зберігаємо всі пари, знайдені за цей прохід.
  const collisions: [T, T][] = []; // Масив буде результатом функції.
  // Перебираємо кожен об'єкт один раз як перший учасник пари.
  for (let i = 0; i < entities.length; i += 1) {
    // Зовнішній цикл задає перший об'єкт.
    // Перебираємо лише об'єкти після i, щоб не повторювати пари.
    for (let j = i + 1; j < entities.length; j += 1) {
      // Внутрішній цикл задає другий об'єкт.
      // Читаємо об'єкти за індексами для зрозумілої перевірки.
      const a = entities[i]; // Перший об'єкт пари.
      const b = entities[j]; // Другий об'єкт пари.
      if (!a || !b) continue; // Захищаємося від відсутнього елемента за індексом.
      // Пропускаємо мертвих або несумісних учасників зіткнення.
      if (a.isDead || b.isDead || !canCollide(a, b)) continue; // Перевіряємо фільтр до геометрії.
      // Додаємо пару лише тоді, коли два кола перетнулися.
      if (circlesOverlap(a, b)) collisions.push([a, b]); // Повертаємо знайдену пару системі гри.
    }
  }
  // Віддаємо результат окремій системі, яка застосовує шкоду й ефекти.
  return collisions; // Повертаємо список пар зіткнень.
}
