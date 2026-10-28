// ui/lobby.js: усе, що стосується HTML. Мережі тут немає:
// модуль лише слухає події Lobby і показує дані.

// Перетворює технічну помилку на зрозумілий текст для гравця.
function friendlyError(error) {
  // TimeoutError: спрацював AbortSignal.timeout (сервер не відповів вчасно).
  if (error.name === 'TimeoutError') return 'сервер не відповідає (таймаут)';
  // HttpError: наш клас з loader.js, має поле status (404, 500...).
  if (error.name === 'HttpError') return `помилка сервера ${error.status}`;
  // SyntaxError: прийшов зламаний JSON.
  if (error.name === 'SyntaxError') return 'сервер надіслав пошкоджені дані';
  // Усе інше: найчастіше немає з'єднання.
  return 'немає з\'єднання';
}

// lobby це екземпляр Lobby, root це <div id="lobby">.
export function createLobbyView(lobby, root) {
  // Будуємо розмітку. Дані з сервера сюди НЕ вставляємо (див. renderRooms).
  root.innerHTML = `
    <h1>Лобі</h1>
    <label>Ім'я: <input id="lobby-name" maxlength="16" placeholder="Пілот"></label>
    <ul id="lobby-rooms"></ul>
    <p id="lobby-status">Завантаження кімнат...</p>
    <button id="lobby-retry" hidden>Спробувати ще раз</button>
    <button id="lobby-join">Приєднатися</button>
  `;

  // Знаходимо потрібні елементи всередині root.
  const nameInput = root.querySelector('#lobby-name');
  const list = root.querySelector('#lobby-rooms');
  const status = root.querySelector('#lobby-status');
  const retryBtn = root.querySelector('#lobby-retry');
  const joinBtn = root.querySelector('#lobby-join');

  // Обрана кімната. Зберігаємо тут, бо список перемальовується кожні 3 с.
  let selectedId = null;

  // Малює список кімнат.
  function renderRooms(rooms) {
    list.replaceChildren(); // очищаємо список

    for (const room of rooms) {
      const li = document.createElement('li');
      const label = document.createElement('label');

      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = 'room';
      radio.checked = room.id === selectedId;
      // Обрали кімнату: запам'ятовуємо.
      radio.addEventListener('change', () => { selectedId = room.id; });

      // textContent вставляє текст як ТЕКСТ, а не як HTML,
      // тому чужий текст із сервера не може зламати сторінку.
      const text = document.createElement('span');
      text.textContent = ` ${room.name}  (${room.players}/${room.maxPlayers})`;

      label.append(radio, text);
      li.append(label);
      list.append(li);
    }
  }

  // Підписки на події Lobby.
  lobby.addEventListener('roomsChanged', (e) => {
    renderRooms(e.detail); // e.detail це масив кімнат
    status.textContent = `Оновлено о ${new Date().toLocaleTimeString('uk-UA')}`;
    retryBtn.hidden = true;
  });

  lobby.addEventListener('refreshFailed', (e) => {
    // e.detail це помилка. Показуємо зрозумілий текст і кнопку повтору.
    status.textContent = `Не вдалося оновити: ${friendlyError(e.detail)}. Повторю автоматично.`;
    retryBtn.hidden = false;
  });

  // Після «Приєднатися» лобі ховається.
  lobby.addEventListener('joined', () => { root.hidden = true; });

  retryBtn.addEventListener('click', () => lobby.refresh());

  joinBtn.addEventListener('click', () => {
    try {
      lobby.join(selectedId, nameInput.value);
    } catch (error) {
      // Помилка валідації: пишемо текст у рядок статусу.
      status.textContent = error.message;
    }
  });

  // Повертаємо дві команди для main.js.
  return {
    show() { root.hidden = false; lobby.start(); }, // показали й запустили оновлення
    hide() { root.hidden = true; lobby.stop(); },   // сховали й скасували запити
  };
}