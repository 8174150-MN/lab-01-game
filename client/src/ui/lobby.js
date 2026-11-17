// Цей модуль створює лише DOM лобі та підписується на події Lobby.
function errorText(error) {
  if (error.name === 'TimeoutError') return 'сервер не відповідає вчасно'; // Пояснюємо таймаут звичайними словами.
  if (error.name === 'HttpError') return 'сервер повернув HTTP ' + error.status; // Показуємо статус без технічного стеку.
  if (error.name === 'SyntaxError') return 'сервер повернув пошкоджений JSON'; // Відрізняємо помилку формату даних.
  return error.message || 'немає з’єднання'; // Показуємо повідомлення мережевої помилки.
} // Завершуємо перетворення помилки.

export function createLobbyView(lobby, root) {
  root.replaceChildren(); // Прибираємо старий вміст перед створенням нового подання.
  root.innerHTML =
    '<h1>Кімнати</h1><label>Ім’я <input id=\"lobby-name\" maxlength=\"24\" placeholder=\"Пілот\"></label><label>Нова кімната <input id=\"room-name\" maxlength=\"40\" placeholder=\"Назва кімнати\"></label><button id=\"lobby-create\">Створити кімнату</button><ul id=\"lobby-rooms\"></ul><p id=\"lobby-status\">Завантаження кімнат…</p><button id=\"lobby-retry\" hidden>Оновити</button><button id=\"lobby-join\">Приєднатися</button>'; // Створюємо поля, список, статус і кнопки лобі.
  const nameInput = root.querySelector('#lobby-name'); // Поле з ім'ям гравця.
  const roomNameInput = root.querySelector('#room-name'); // Поле для нового імені кімнати.
  const createButton = root.querySelector('#lobby-create'); // Кнопка викликає POST /api/rooms.
  const list = root.querySelector('#lobby-rooms'); // Список буде оновлюватися з відповіді API.
  const status = root.querySelector('#lobby-status'); // Тут показуються прогрес і помилки.
  const retryButton = root.querySelector('#lobby-retry'); // Кнопка повторює GET-запит.
  const joinButton = root.querySelector('#lobby-join'); // Кнопка запускає вибрану кімнату.
  let selectedId = null; // Обрана кімната лишається активною між оновленнями списку.

  // Перемальовує кімнати та додає безпечні текстові підписи.
  function renderRooms(rooms) {
    list.replaceChildren(); // Очищаємо попередні рядки перед новим списком.
    if (rooms.length === 0) status.textContent = 'Кімнат поки немає — створи нову.'; // Пояснюємо порожній список.
    for (const room of rooms) {
      // Створюємо окремий рядок для кожної кімнати.
      const item = document.createElement('li'); // Рядок списку кімнат.
      const label = document.createElement('label'); // Мітка дозволяє натискати по всьому рядку.
      const radio = document.createElement('input'); // Перемикач позначає вибрану кімнату.
      radio.type = 'radio'; // Вибирати можна лише одну кімнату.
      radio.name = 'room'; // Спільне ім'я групує перемикачі браузером.
      radio.checked = room.id === selectedId; // Зберігаємо попередній вибір після опитування.
      radio.addEventListener('change', () => {
        selectedId = room.id;
      }); // Запам'ятовуємо вибрану кімнату.
      const text = document.createElement('span'); // Текст показує кількість гравців.
      text.textContent = room.name + ' (' + room.players + '/' + room.maxPlayers + ')'; // textContent не дозволяє серверному імені виконати HTML.
      label.append(radio, text); // Складаємо перемикач і назву в одну мітку.
      item.append(label); // Додаємо мітку до рядка списку.
      list.append(item); // Додаємо рядок до лобі.
    } // Завершуємо малювання доступних кімнат.
  } // Завершуємо оновлення списку.

  lobby.addEventListener('roomsChanged', (event) => {
    renderRooms(event.detail);
    status.textContent = 'Оновлено о ' + new Date().toLocaleTimeString('uk-UA');
    retryButton.hidden = true;
  }); // Показуємо список після успішного GET.
  lobby.addEventListener('refreshFailed', (event) => {
    status.textContent = 'Не вдалося оновити: ' + errorText(event.detail);
    retryButton.hidden = false;
  }); // Даємо гравцю ручний повтор.
  lobby.addEventListener('joined', () => {
    root.hidden = true;
  }); // Ховаємо список після успішного Join.
  retryButton.addEventListener('click', () => lobby.refresh()); // Повторюємо GET за натисканням.
  createButton.addEventListener('click', async () => {
    try {
      await lobby.createRoom(roomNameInput.value);
      roomNameInput.value = '';
    } catch (error) {
      status.textContent = 'Не вдалося створити кімнату: ' + errorText(error);
    }
  }); // Створюємо кімнату й показуємо помилку в лобі.
  joinButton.addEventListener('click', () => {
    try {
      lobby.join(selectedId, nameInput.value);
    } catch (error) {
      status.textContent = error.message;
    }
  }); // Перевіряємо вибір і починаємо локальну гру.

  // Повертаємо команди видимості; запити живуть лише поки видно лобі.
  return {
    show() {
      root.hidden = false;
      lobby.start();
    }, // Показуємо екран і запускаємо перше оновлення.
    hide() {
      root.hidden = true;
      lobby.stop();
    }, // Ховаємо екран і перериваємо запит, що триває.
  }; // Завершуємо інтерфейс подання.
} // Завершуємо створення DOM лобі.
