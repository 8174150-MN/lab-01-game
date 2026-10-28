// errorScreen.js: екран помилки з кнопкою Retry (чистий DOM, без мережі).
//   root     елемент <div id="errorScreen">
//   message  текст помилки для гравця
//   onRetry  функція, яку викличемо при натисканні Retry
export function showError(root, message, onRetry) {
  root.replaceChildren(); // очищаємо старий вміст

  const p = document.createElement('p');
  p.textContent = message; // textContent вставляє текст безпечно

  const btn = document.createElement('button');
  btn.textContent = 'Retry';
  // { once: true }: обробник спрацює один раз, потім сам зніметься.
  btn.addEventListener('click', () => {
    root.hidden = true;
    onRetry();
  }, { once: true });

  root.append(p, btn);
  root.hidden = false; // показуємо екран
}