import { defineConfig, devices } from '@playwright/test'; // Налаштовуємо браузерний сценарій.

export default defineConfig({
  testDir: './e2e', // Зберігаємо Playwright сценарії окремо від unit-тестів.
  testIgnore: '**/profile.spec.ts', // Тридцятисекундний профіль запускається тільки окремою командою.
  globalSetup: './e2e/global-setup.ts', // Самі запускаємо й завершуємо сервери на Windows без завислих npm дочірніх процесів.
  fullyParallel: false, // Один браузерний сценарій зменшує навантаження на ноутбук і CI.
  workers: 1, // Не запускаємо кілька важких браузерів одночасно.
  timeout: 60_000, // Даємо слабкому локальному ноутбуку час на запуск двох браузерних сторінок.
  reporter: 'list', // Показуємо короткий результат у терміналі й CI.
  use: {
    ...devices['Desktop Chrome'], // Використовуємо Chromium у звичайному розмірі вікна.
    baseURL: 'http://127.0.0.1:' + (process.env.LAB7_E2E_CLIENT_PORT ?? '4177'), // Тест відкриває ізольований Vite server.
    headless: true, // Не відкриваємо видиме вікно під час автоматичної перевірки.
    launchOptions: process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}, // Локально дозволяємо встановлений Edge, а в CI беремо Chromium від Playwright.
    trace: 'off', // Не витрачаємо пам'ять і час teardown на запис trace у короткому smoke-тесті.
  },
}); // Завершуємо конфіг Playwright.
