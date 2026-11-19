import { defineConfig, devices } from '@playwright/test'; // Окремий запуск не додає довгий профіль до звичайного E2E/CI.

export default defineConfig({
  testDir: './e2e', // Зберігаємо сценарій поруч з іншими браузерними тестами.
  testMatch: '**/profile.spec.ts', // Цей конфіг запускає лише профіль, а не звичайний E2E набір.
  globalSetup: './e2e/global-setup.ts', // Запускаємо ті самі Vite і Node сервери.
  fullyParallel: false, // Не запускаємо другий важкий браузер під час вимірювання.
  workers: 1, // Один браузер відповідає умовам одного профілю.
  timeout: 90_000, // Відводимо час на запуск і тридцять секунд гри.
  reporter: 'list', // Друкуємо профіль і результат прямо в термінал.
  use: {
    ...devices['Desktop Chrome'], // Запускаємо настільний розмір вікна.
    baseURL: 'http://127.0.0.1:' + (process.env.LAB7_E2E_CLIENT_PORT ?? '4177'), // Використовуємо ізольований тестовий Vite server.
    headless: true, // Не займаємо екран окремим вікном.
    launchOptions: process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}, // Локально беремо Edge, CI може використати Chromium.
    trace: 'off', // Записуємо окремий V8 CPU profile замість важкого Playwright trace.
  },
}); // Завершуємо конфігурацію окремого профілю.
