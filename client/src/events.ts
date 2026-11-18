// Шина подій: спільний "гучномовець" для всієї гри.
// EventTarget це вбудований браузерний клас, який вміє надсилати
// події й приймати підписників (як кнопки в HTML).
// export означає, що шину можна підключити в інших файлах.
export const bus = new EventTarget();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function on<Detail>(
  type: string,
  isDetail: (value: unknown) => value is Detail,
  listener: (detail: Detail) => void,
): () => void {
  const handle = (event: Event) => {
    if (event instanceof CustomEvent && isDetail(event.detail)) listener(event.detail);
  };
  bus.addEventListener(type, handle);
  return () => bus.removeEventListener(type, handle);
}

// emit("fired") це коротка функція: "оголоси подію fired".
// type: назва події ("fired", "hit", "exploded").
// detail: додаткові дані (наприклад, де вибухнуло); за замовчуванням
// порожній об'єкт {}.
export function emit(type: string, detail: Record<string, unknown> = {}): void {
  // CustomEvent це подія з нашими даними в полі detail.
  // dispatchEvent розсилає її всім, хто підписався.
  bus.dispatchEvent(new CustomEvent(type, { detail }));
}
