import { expect, test } from '@playwright/test'; // Перевіряємо, що серверний бот грає через звичайний інтерфейс.

test('server AI bot joins the room, moves and appears in the roster', async ({ page }) => {
  await page.goto('/?lab7-e2e=1'); // Завантажуємо гру з тестовим доступом до останнього серверного знімка.
  await page.getByRole('button', { name: 'Почати' }).click(); // Розблоковуємо аудіо та запускаємо гру.
  await expect(page.locator('#lobby')).toBeVisible(); // Чекаємо, поки з'явиться лобі.
  await page.locator('#lobby-name').fill('Bot Observer'); // Даємо браузерному спостерігачу зрозуміле ім'я.
  const room = page.locator('#lobby-rooms input[type="radio"]').first(); // Обираємо створену сервером кімнату.
  await expect(room).toBeVisible(); // Чекаємо перше оновлення списку кімнат.
  await room.check(); // Входимо саме в цю кімнату з браузера.
  const roomsResponse = await page.request.get('/api/rooms'); // Запитуємо ті самі дані кімнат, які показує лобі.
  const rooms: Array<{ id: string }> = await roomsResponse.json(); // Читаємо серверний id із відповіді API.
  const roomId = rooms[0]?.id; // Вибраний перший radio відповідає першій кімнаті у списку.
  if (!roomId) throw new Error('Lobby API returned no room id'); // Не надсилаємо запит із порожнім ідентифікатором.
  await page.locator('#net-authoritative').check(); // Під'єднуємося до серверної симуляції.
  await page.locator('#lobby-join').click(); // Приєднуємо браузер як спостерігача матчу.
  await expect(page.locator('#chatBox')).toBeVisible(); // Чекаємо успішного з'єднання з кімнатою.

  const response = await page.request.post('/api/rooms/' + encodeURIComponent(roomId) + '/bots', {
    data: { count: 2 },
  }); // Додаємо два AI через новий серверний endpoint.
  expect(response.status()).toBe(201); // API підтвердив створення ботів.
  await expect(page.locator('#roomRoster')).toContainText('Bot 1'); // Обидва клієнти використовують звичайний roster.
  await expect(page.locator('#roomRoster')).toContainText('Bot 2'); // Перевіряємо другого серверного гравця.

  const readBot = () =>
    page.evaluate(() => {
      const testWindow = window as Window & {
        __lab7Snapshot?: () => { players: Array<{ name: string; x: number; y: number }> } | null;
      }; // Читаємо тільки опційний тестовий знімок, не відкриваючи внутрішні поля гри.
      return testWindow.__lab7Snapshot?.()?.players.find((player) => player.name === 'Bot 1') ?? null; // Вибираємо координати першого бота.
    }); // Виконуємо читання у контексті сторінки гри.

  await expect.poll(readBot, { timeout: 5000 }).not.toBeNull(); // Чекаємо першого серверного snapshot з ботом.
  const initial = await readBot(); // Запам'ятовуємо початкове положення корабля.
  if (!initial) throw new Error('Server snapshot did not include Bot 1'); // Пояснюємо помилку, якщо знімок порожній.
  await expect
    .poll(
      async () => {
        const current = await readBot(); // Беремо наступний знімок із серверної симуляції.
        return current ? Math.hypot(current.x - initial.x, current.y - initial.y) : 0; // Вимірюємо, чи бот зрушив із місця.
      },
      { timeout: 5000 },
    )
    .toBeGreaterThan(1); // Підтверджуємо, що AI надсилає input, який змінює стан корабля.
}); // Завершуємо перевірку server-side AI.
