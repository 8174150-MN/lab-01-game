// Створюємо клавіатурний ввід як замикання над двома приватними наборами.
export function createInput(target = window) {
  const down = new Set(); // Зберігаємо клавіші, які зараз утримуються.
  const pressed = new Set(); // Зберігаємо клавіші, що перейшли в натиснутий стан цього кадру.

  // Реєструємо нове натискання лише один раз, а повтори клавіатури ігноруємо.
  function onKeyDown(event) {
    if (!down.has(event.code) && !event.repeat) pressed.add(event.code); // Фіксуємо перехід для justPressed.
    down.add(event.code); // Позначаємо клавішу як утримувану.
  } // Завершуємо обробку натискання.

  // При відпусканні прибираємо клавішу зі стану утримання.
  function onKeyUp(event) {
    down.delete(event.code); // Клавіша більше не вважається активною.
  } // Завершуємо обробку відпускання.

  // Якщо вікно втратило фокус, очищаємо клавіші, щоб не лишилися затиснутими.
  function onBlur() {
    down.clear(); // Скидаємо всі активні клавіші.
    pressed.clear(); // Скидаємо застарілі натискання.
  } // Завершуємо очищення після втрати фокусу.

  target.addEventListener('keydown', onKeyDown); // Підписуємося на натискання клавіш.
  target.addEventListener('keyup', onKeyUp); // Підписуємося на відпускання клавіш.
  target.addEventListener('blur', onBlur); // Скидаємо клавіші, коли вкладка втрачає фокус.

  // Повертаємо тільки методи для читання та керування ввідом.
  return {
    isDown: (code) => down.has(code), // Перевіряємо, чи клавішу тримають натиснутою.
    justPressed: (code) => pressed.has(code), // Перевіряємо одноразовий перехід у натиснутий стан.
    clearJustPressed: () => pressed.clear(), // Очищаємо переходи після кроку симуляції.
    destroy() {
      target.removeEventListener('keydown', onKeyDown);
      target.removeEventListener('keyup', onKeyUp);
      target.removeEventListener('blur', onBlur);
    }, // Знімаємо всі слухачі при закритті гри.
  }; // Завершуємо публічний інтерфейс.
} // Завершуємо фабрику клавіатури.
