import { expect, test } from '@playwright/test'; // Перевіряємо доступність лабораторного Worker експерименту в браузері.

test('worker benchmark runs the same bot inputs in both contexts', async ({ page }) => {
  await page.goto('/worker-benchmark.html'); // Відкриваємо окрему діагностичну сторінку без завантаження гри.
  await page.getByRole('button', { name: 'Почати вимір' }).click(); // Запускаємо main-thread і Worker варіанти.
  const output = page.locator('#result'); // Читаємо JSON результат після обох прогонів.
  await expect(output).toContainText('main thread', { timeout: 10_000 }); // Чекаємо завершення синхронної базової роботи.
  await expect(output).toContainText('Web Worker', { timeout: 10_000 }); // Переконуємося, що Web Worker теж повернув результат.
  await expect(output).toContainText('mainThreadMoreResponsive'); // Звіт містить вимір затримки основного потоку.
  console.log('[Worker experiment]', await output.textContent()); // Записуємо реальні числа в CI log для README.
}); // Завершуємо smoke-тест діагностики Worker.
