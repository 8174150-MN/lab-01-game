// Заповнюємо компактний буфер детермінованими input, однаковими для main thread і Worker.
export function fillBotInputs(target: Uint8Array, botCount: number, ticks: number): void {
  let offset = 0; // Один лічильник пише три байти на кожного бота в кожному кроці.
  for (let tick = 0; tick < ticks; tick += 1) {
    for (let bot = 0; bot < botCount; bot += 1) {
      target[offset] = (tick + bot) % 3 === 0 ? 1 : 0; // Байтом кодуємо gas так само, як булеве керування гравця.
      target[offset + 1] = ((tick + bot) % 3) - 1 + 1; // Кодуємо поворот -1/0/1 як 0/1/2.
      target[offset + 2] = (tick + bot) % 7 === 0 ? 1 : 0; // Кодуємо коротку команду пострілу.
      offset += 3; // Переходимо до наступних полів input.
    } // Завершуємо input всіх ботів у цьому кроці.
  } // Завершуємо детерміновану серію кроків.
} // Завершуємо заповнення буфера керування.
