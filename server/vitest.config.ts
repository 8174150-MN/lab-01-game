import { defineConfig } from 'vitest/config'; // Підключаємо конфіг тестів сервера.

export default defineConfig({
  root: import.meta.dirname, // Вказуємо корінь server незалежно від каталогу виклику npm.
  test: {
    include: ['test/**/*.vitest.ts'], // Залишаємо інтеграційні Node-тести чинними окремо.
    environment: 'node', // Серверні функції запускаються в середовищі Node.js.
    setupFiles: ['test/setup.ts'], // Перед імпортом сервера задаємо невеликий тестовий rate limit.
  },
});
