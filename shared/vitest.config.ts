import { defineConfig } from 'vitest/config'; // Використовуємо конфіг саме тестового інструмента.

export default defineConfig({
  root: import.meta.dirname, // Вказуємо корінь shared незалежно від каталогу виклику npm.
  test: {
    include: ['test/**/*.vitest.ts'], // Ізолюємо Vitest-тести від наявного Node test runner.
    environment: 'node', // Спільна симуляція не потребує браузерного DOM.
    coverage: {
      provider: 'v8', // Збираємо покриття з реального виконання коду V8.
      include: ['engine.ts', 'protocol.ts', 'vector.ts'], // Вимірюємо спільний код протоколу й симуляції.
      exclude: ['types.ts'], // Файл типів не має runtime-логіки для покриття.
      thresholds: { lines: 85, functions: 85, branches: 80, statements: 85 }, // Задаємо поріг лабораторної.
    },
  },
});
