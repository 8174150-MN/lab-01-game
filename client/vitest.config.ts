import { defineConfig } from 'vitest/config'; // Підключаємо конфіг для клієнтського набору тестів.

export default defineConfig({
  root: import.meta.dirname, // Вказуємо корінь client незалежно від каталогу виклику npm.
  test: {
    include: ['test/**/*.vitest.ts'], // Запускаємо лише нові Vitest-набори клієнта.
    environment: 'node', // Перевіряємо чисті модулі без запуску браузера.
  },
});
