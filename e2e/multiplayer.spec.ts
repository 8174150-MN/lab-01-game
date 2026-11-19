import { expect, test, type BrowserContext, type Page } from '@playwright/test'; // Керуємо двома ізольованими браузерними вікнами.

// Завантажуємо гру, вибираємо початкову кімнату та чекаємо підтвердження входу.
async function joinGame(context: BrowserContext, name: string): Promise<Page> {
  const page = await context.newPage(); // Кожен гравець отримує окрему сторінку.
  page.on('pageerror', (error) => console.error('[browser ' + name + ']', error.message)); // Виводимо помилки клієнта з вкладки у лог Playwright.
  await page.goto('/?lab7-e2e=1'); // Увімкнений URL-параметр дозволяє тесту читати серверний знімок.
  await page.getByRole('button', { name: 'Почати' }).click(); // Розблоковуємо Web Audio і запускаємо завантаження.
  await expect(page.locator('#lobby')).toBeVisible(); // Чекаємо появи лобі після завантаження активів.
  await page.locator('#lobby-name').fill(name); // Вводимо унікальне ім'я пілота.
  await expect(page.locator('#lobby-rooms input[type="radio"]').first()).toBeVisible(); // Чекаємо на кімнату від реального API.
  await page.locator('#lobby-rooms input[type="radio"]').first().check(); // Вибираємо одну й ту саму початкову кімнату.
  await page.locator('#net-authoritative').check(); // Вмикаємо серверний режим, у якому сервер надсилає повні знімки стану.
  await expect(page.locator('#net-authoritative')).toBeChecked(); // Перевіряємо, що лобі справді ввімкнуло серверну симуляцію.
  await page.locator('#lobby-join').click(); // Підключаємося через штатний інтерфейс лобі.
  await expect(page.locator('#chatBox')).toBeVisible(); // Успішний вхід відкриває чат матчу.
  return page; // Повертаємо керування сторінкою гравцеві.
} // Завершуємо вхід у гру.

// Читаємо координати іншого гравця з останнього authoritative snapshot.
async function readPlayer(page: Page, playerName: string): Promise<{ x: number; y: number; angle: number } | null> {
  return page.evaluate((name) => {
    const testWindow = window as Window & {
      __lab7Snapshot?: () => { players: Array<{ name: string; x: number; y: number; angle: number }> } | null;
    }; // Звертаємось до опційного E2E hook.
    const snapshot = testWindow.__lab7Snapshot?.(); // Беремо останній серверний кадр, отриманий цією вкладкою.
    const player = snapshot?.players.find((candidate) => candidate.name === name); // Шукаємо корабель першого гравця.
    return player ? { x: player.x, y: player.y, angle: player.angle } : null; // Повертаємо лише поля для перевірки руху.
  }, playerName); // Передаємо ім'я в контекст браузера.
} // Завершуємо читання стану іншого гравця.

// Рахуємо кулі гравця в останньому серверному знімку.
async function readBulletCount(page: Page, playerName: string): Promise<number> {
  return page.evaluate((name) => {
    const testWindow = window as Window & {
      __lab7Snapshot?: () => {
        players: Array<{ id: string; name: string }>;
        bullets: Array<{ ownerId: string }>;
      } | null;
    }; // Читаємо лише типізований тестовий зріз авторитетного кадру.
    const snapshot = testWindow.__lab7Snapshot?.(); // Беремо останній кадр, отриманий другим браузером.
    const player = snapshot?.players.find((candidate) => candidate.name === name); // Знаходимо власника пострілів.
    return snapshot && player ? snapshot.bullets.filter((bullet) => bullet.ownerId === player.id).length : 0; // Рахуємо тільки його активні кулі.
  }, playerName); // Передаємо ім'я пілота у браузерний контекст.
} // Завершуємо підрахунок куль.

test('two browser contexts see each other move and receive chat', async ({ browser }) => {
  const firstContext = await browser.newContext(); // Створюємо окрему сесію першого пілота.
  const secondContext = await browser.newContext(); // Створюємо окрему сесію другого пілота.
  try {
    const first = await joinGame(firstContext, 'Pilot One'); // Перший пілот входить у початкову кімнату.
    const second = await joinGame(secondContext, 'Pilot Two'); // Другий входить у ту саму кімнату.
    await expect(first.locator('#roomRoster')).toContainText('Pilot One'); // Перший клієнт отримав свій roster.
    await expect(first.locator('#roomRoster')).toContainText('Pilot Two'); // Перший бачить другого гравця.
    await expect(second.locator('#roomRoster')).toContainText('Pilot One'); // Другий клієнт отримав roster першого.
    await expect(second.locator('#roomRoster')).toContainText('Pilot Two'); // Другий клієнт бачить і себе.
    await expect.poll(() => readPlayer(second, 'Pilot One'), { timeout: 5000 }).not.toBeNull(); // Дочікуємося першого знімка корабля першого пілота.
    const before = await readPlayer(second, 'Pilot One'); // Фіксуємо його початкові координати й кут.
    if (!before) throw new Error('Second client did not receive the first ship'); // Зупиняємо тест із ясною причиною.
    await first.bringToFront(); // Фокусуємо саме той браузерний контекст, який має отримати клавіатуру.
    await first.keyboard.down('ArrowRight'); // Повертаємо носа корабля до напрямку руху.
    await first.keyboard.down('ArrowUp'); // Прискорюємо перший корабель звичайним керуванням.
    await expect
      .poll(
        async () => {
          const current = await readPlayer(second, 'Pilot One'); // Беремо наступний authoritative snapshot другого клієнта.
          return current ? Math.hypot(current.x - before.x, current.y - before.y) : 0; // Рахуємо реальне зміщення корабля в арені.
        },
        { timeout: 500 },
      )
      .toBeGreaterThan(1); // Другий клієнт отримує помітне зміщення після кількох серверних кроків.
    await first.keyboard.up('ArrowRight'); // Відпускаємо поворот після підтвердженого руху.
    await first.keyboard.up('ArrowUp'); // Відпускаємо тягу після підтвердженого руху.
    await first.locator('#chatInput').fill('hello from browser one'); // Вводимо повідомлення в чат першого гравця.
    await first.locator('#chatForm button').click(); // Надсилаємо повідомлення штатною кнопкою.
    await expect(second.locator('#chatMessages')).toContainText('hello from browser one'); // Перевіряємо доставку в інше вікно.
    const bulletsBefore = await readBulletCount(second, 'Pilot One'); // Запам'ятовуємо кількість куль до команди пострілу.
    await first.keyboard.press('Space'); // Надсилаємо один звичайний натиск пробілу першому пілоту.
    await expect.poll(() => readBulletCount(second, 'Pilot One'), { timeout: 500 }).toBeGreaterThan(bulletsBefore); // Другий клієнт швидко бачить кулю, створену сервером.
  } finally {
    await Promise.all([firstContext.close(), secondContext.close()]); // Закриваємо кімнатні сесії навіть після помилки.
  } // Завершуємо сценарій двох гравців.
}); // Завершуємо E2E тест мультиплеєра.
