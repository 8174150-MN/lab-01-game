// Описуємо найменшу можливість, потрібну WebSocket-обробнику.
export interface RateLimiter {
  consume(): boolean; // Повертає true, якщо повідомлення можна прийняти зараз.
} // Завершуємо контракт токен-бакета.

// Створюємо токен-бакет із заданою місткістю та швидкістю поповнення.
export function createRateLimiter(
  capacity: number,
  refillPerSecond: number,
  now: () => number = () => performance.now(),
): RateLimiter {
  if (!Number.isFinite(capacity) || capacity < 1) throw new RangeError('capacity must be at least 1'); // Захищаємо бакет від некоректної конфігурації.
  if (!Number.isFinite(refillPerSecond) || refillPerSecond <= 0)
    throw new RangeError('refillPerSecond must be positive'); // Вимагаємо додатну швидкість поповнення.
  let tokens = capacity; // Нове з'єднання починає з повним запасом.
  let refilledAt = now(); // Запам'ятовуємо початковий монотонний час.
  return {
    consume(): boolean {
      const currentTime = now(); // Читаємо час з ін'єктованого годинника для тестованості.
      const elapsedSeconds = Math.max(0, (currentTime - refilledAt) / 1000); // Від'ємний час не створює зайвих токенів.
      tokens = Math.min(capacity, tokens + elapsedSeconds * refillPerSecond); // Поповнюємо бакет, але не вище ліміту.
      refilledAt = currentTime; // Наступний виклик рахує час лише від цього моменту.
      if (tokens < 1) return false; // Не приймаємо повідомлення без цілого токена.
      tokens -= 1; // Витрачаємо один токен на прийняте повідомлення.
      return true; // Повідомлення вкладається в ліміт частоти.
    }, // Завершуємо перевірку одного повідомлення.
  }; // Повертаємо незалежний ліміт для цього сокета.
} // Завершуємо фабрику токен-бакета.
