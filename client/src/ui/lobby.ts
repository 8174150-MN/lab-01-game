// Цей модуль створює лише DOM лобі та підписується на події Lobby.
import type { Lobby, LobbyRoom } from '../lobby.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isLobbyRoom(value: unknown): value is LobbyRoom {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    typeof value.players === 'number' &&
    typeof value.maxPlayers === 'number'
  );
}

function required<T extends HTMLElement>(root: HTMLElement, selector: string, type: { new (): T }): T {
  const element = root.querySelector(selector);
  if (!(element instanceof type)) throw new Error('Не знайдено елемент лобі ' + selector);
  return element;
}

function errorText(error: unknown): string {
  if (!(error instanceof Error)) return 'немає з’єднання';
  if (error.name === 'TimeoutError') return 'сервер не відповідає вчасно'; // Пояснюємо таймаут звичайними словами.
  if (error.name === 'HttpError' && 'status' in error && typeof error.status === 'number')
    return 'сервер повернув HTTP ' + error.status; // Показуємо статус без технічного стеку.
  if (error.name === 'SyntaxError') return 'сервер повернув пошкоджений JSON'; // Відрізняємо помилку формату даних.
  return error.message || 'немає з’єднання'; // Показуємо повідомлення мережевої помилки.
} // Завершуємо перетворення помилки.

export function createLobbyView(lobby: Lobby, root: HTMLElement) {
  root.replaceChildren(); // Прибираємо старий вміст перед створенням нового подання.
  root.innerHTML =
    '<h1>Кімнати</h1><label>Ім’я <input id=\"lobby-name\" maxlength=\"24\" placeholder=\"Пілот\"></label><label>Нова кімната <input id=\"room-name\" maxlength=\"40\" placeholder=\"Назва кімнати\"></label><button id=\"lobby-create\">Створити кімнату</button><ul id=\"lobby-rooms\"></ul><label>Формат <select id=\"net-format\"><option value=\"binary\">Бінарний</option><option value=\"json\">JSON для порівняння</option></select></label><label>Затримка, мс <input id=\"net-latency\" type=\"number\" min=\"0\" max=\"500\" value=\"0\"></label><label>Розкид, мс <input id=\"net-jitter\" type=\"number\" min=\"0\" max=\"200\" value=\"0\"></label><label>Втрата пакетів, % <input id=\"net-loss\" type=\"number\" min=\"0\" max=\"30\" value=\"0\"></label><label><input id=\"net-prediction\" type=\"checkbox\" checked> Передбачати рух свого корабля</label><p id=\"lobby-status\">Завантаження кімнат…</p><button id=\"lobby-retry\" hidden>Оновити</button><button id=\"lobby-join\">Приєднатися</button>'; // Створюємо кімнати та мережеві налаштування для досліду.
  const nameInput = required(root, '#lobby-name', HTMLInputElement); // Поле з ім'ям гравця.
  const roomNameInput = required(root, '#room-name', HTMLInputElement); // Поле для нового імені кімнати.
  const createButton = required(root, '#lobby-create', HTMLButtonElement); // Кнопка викликає POST /api/rooms.
  const list = required(root, '#lobby-rooms', HTMLUListElement); // Список буде оновлюватися з відповіді API.
  const status = required(root, '#lobby-status', HTMLParagraphElement); // Тут показуються прогрес і помилки.
  const retryButton = required(root, '#lobby-retry', HTMLButtonElement); // Кнопка повторює GET-запит.
  const joinButton = required(root, '#lobby-join', HTMLButtonElement); // Кнопка запускає вибрану кімнату.
  const formatInput = required(root, '#net-format', HTMLSelectElement); // Дозволяє порівняти компактний пакет і JSON.
  const latencyInput = required(root, '#net-latency', HTMLInputElement); // Задає штучний час доставки пакета.
  const jitterInput = required(root, '#net-jitter', HTMLInputElement); // Задає випадковий розкид біля затримки.
  const lossInput = required(root, '#net-loss', HTMLInputElement); // Задає частку пакетів, які симулятор відкидає.
  const predictionInput = required(root, '#net-prediction', HTMLInputElement); // Вимикається для показу руху лише після snapshot.
  const authoritativeInput = document.createElement('input'); // Окремий перемикач залишає мережеву лабораторну вимкненою за замовчуванням.
  authoritativeInput.type = 'checkbox'; // Гравець вмикає серверну симуляцію лише для демонстрації лабораторної 5.
  authoritativeInput.id = 'net-authoritative'; // Даємо перемикачу зрозумілий ідентифікатор у DOM.
  const authoritativeLabel = document.createElement('label'); // Підпис пояснює, що саме змінює прапорець.
  authoritativeLabel.append(authoritativeInput, ' Серверна гра'); // Локальний режим нижче лишається грою з лабораторної 4.
  const formatLabel = formatInput.closest('label');
  if (!formatLabel) throw new Error('Поле формату має бути всередині label');
  formatLabel.before(authoritativeLabel); // Ставимо вибір режиму перед рештою мережевих параметрів.
  let selectedId: string | null = null; // Обрана кімната лишається активною між оновленнями списку.

  // Перемальовує кімнати та додає безпечні текстові підписи.
  function renderRooms(rooms: readonly LobbyRoom[]): void {
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
    if (event instanceof CustomEvent && Array.isArray(event.detail) && event.detail.every(isLobbyRoom)) {
      renderRooms(event.detail);
      status.textContent = 'Оновлено о ' + new Date().toLocaleTimeString('uk-UA');
      retryButton.hidden = true;
    }
  }); // Показуємо список після успішного GET.
  lobby.addEventListener('refreshFailed', (event) => {
    if (event instanceof CustomEvent) {
      status.textContent = 'Не вдалося оновити: ' + errorText(event.detail);
      retryButton.hidden = false;
    }
  }); // Даємо гравцю ручний повтор.
  lobby.addEventListener('joined', () => {
    root.hidden = true;
  }); // Ховаємо список після успішного Join.
  retryButton.addEventListener('click', () => lobby.refresh()); // Повторюємо GET за натисканням.
  createButton.addEventListener('click', async () => {
    createButton.disabled = true; // Не дозволяємо створити кілька кімнат подвійним кліком.
    status.textContent = 'Створюємо кімнату…'; // Одразу показуємо, що кнопка прийняла натискання.
    try {
      const created = await lobby.createRoom(roomNameInput.value); // Чекаємо підтвердження від POST-запиту.
      selectedId = created.id; // Одразу позначаємо нову кімнату вибраною.
      roomNameInput.value = '';
      renderRooms(lobby.rooms); // Перемальовуємо список після вибору нової кімнати.
      status.textContent = 'Кімнату створено. Тепер натисни «Приєднатися».'; // Пояснюємо наступну дію.
    } catch (error: unknown) {
      status.textContent = 'Не вдалося створити кімнату: ' + errorText(error);
    } finally {
      createButton.disabled = false; // Дозволяємо створити іншу кімнату після відповіді.
    }
  }); // Створюємо кімнату й показуємо помилку в лобі.
  joinButton.addEventListener('click', () => {
    try {
      lobby.join(selectedId, nameInput.value, {
        authoritative: authoritativeInput.checked,
        format: formatInput.value === 'json' ? 'json' : 'binary',
        latencyMs: Number(latencyInput.value),
        jitterMs: Number(jitterInput.value),
        packetLoss: Number(lossInput.value) / 100,
        prediction: predictionInput.checked,
      });
    } catch (error: unknown) {
      status.textContent = errorText(error);
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
