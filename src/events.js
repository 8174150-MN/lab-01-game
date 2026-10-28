// Шина подій: спільний "гучномовець" для всієї гри.
// EventTarget це вбудований браузерний клас, який вміє надсилати
// події й приймати підписників (як кнопки в HTML).
// export означає, що шину можна підключити в інших файлах.
export const bus = new EventTarget();

// emit("fired") це коротка функція: "оголоси подію fired".
// type: назва події ("fired", "hit", "exploded").
// detail: додаткові дані (наприклад, де вибухнуло); за замовчуванням
// порожній об'єкт {}.
export function emit(type, detail = {}) {
  // CustomEvent це подія з нашими даними в полі detail.
  // dispatchEvent розсилає її всім, хто підписався.
  bus.dispatchEvent(new CustomEvent(type, { detail }));
}