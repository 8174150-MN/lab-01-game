// Експортуємо клас WSClient, щоб його можна було імпортувати в інших файлах проєкту
export class WSClient {
  // Конструктор класу, який викликається при створенні об'єкта new WSClient(url)
  constructor(url) {
    // Зберігаємо URL-адресу WebSocket-сервера (наприклад, 'ws://localhost:3000/ws')
    this.url = url;
    // Змінна для збереження об'єкта WebSocket (початково null, бо ще не підключилися)
    this.ws = null;
    // Черга для повідомлень, які відправляються до того, як сокет встиг відкритися
    this.sendQueue = [];
    // Структура Map для збереження функцій-слухачів подій (event listeners)
    this.listeners = new Map();
    // Лічильник спроб повторного підключення при обриві мережі
    this.reconnectAttempts = 0;
    // Максимальна затримка між спробами підключення (10 секунд у мілісекундах)
    this.maxReconnectDelay = 10000;
    // Прапорець, який вказує, чи закрив користувач сокет навмисно
    this.isIntentionalClose = false;
  }

  // Метод для відкриття з'єднання з WebSocket-сервером
  connect() {
    // При кожній новій спробі підключення скидаємо прапорець навмисного закриття
    this.isIntentionalClose = false;
    // Створюємо новий екземпляр системного класу WebSocket
    this.ws = new WebSocket(this.url);

    // Встановлюємо обробник події для успішного відкриття сокета
    this.ws.onopen = () => {
      // Виводимо в консоль браузера повідомлення про успішне підключення
      console.log('[WSClient] Соединение с сервером установлено');
      // Скидаємо лічильник спроб підключення до нуля
      this.reconnectAttempts = 0;
      // Відправляємо всі накопичені в черзі повідомлення
      this._flushQueue();
      // Викликаємо слухачів події відкриття сокета ('open')
      this._emit('open');
    };

    // Встановлюємо обробник події отримання повідомлення від сервера
    this.ws.onmessage = (event) => {
      // Блок try-catch для безпечного парсингу JSON
      try {
        // Перетворюємо отриманий рядок JSON у звичайний об'єкт JavaScript
        const data = JSON.parse(event.data);
        // Викликаємо загальних слухачів події 'message'
        this._emit('message', data);
        // Перевіряємо, чи є в об'єкті поле 'type'
        if (data.type) {
          // Викликаємо слухачів події конкретного типу (наприклад, 'chat')
          this._emit(data.type, data);
        }
      } catch (e) {
        // Якщо прийшов невалідний JSON, виводимо помилку в консоль
        console.error('[WSClient] Ошибка парсинга сообщения:', e);
      }
    };

    // Встановлюємо обробник події закриття сокета
    this.ws.onclose = (event) => {
      // Виводимо в консоль код закриття сокета
      console.log(`[WSClient] Сокет закрыт (код: ${event.code})`);
      // Сповіщаємо слухачів про закриття сокета
      this._emit('close', event);
      // Перевіряємо, чи закриття було випадковим (обрив зв'язку)
      if (!this.isIntentionalClose) {
        // Запускаємо таймер повторного підключення
        this._scheduleReconnect();
      }
    };

    // Встановлюємо обробник події виникнення помилки
    this.ws.onerror = (err) => {
      // Виводимо об'єкт помилки в консоль
      console.error('[WSClient] Ошибка сокета:', err);
      // Сповіщаємо слухачів про помилку
      this._emit('error', err);
    };
  }

  // Метод для відправки даних на сервер
  send(data) {
    // Якщо передано об'єкт, сериалізуємо його у JSON-рядок
    const payload = typeof data === 'string' ? data : JSON.stringify(data);
    // Перевіряємо, чи існує сокет та чи він у стані OPEN (код 1)
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      // Відправляємо рядок безпосередньо у сокет
      this.ws.send(payload);
    } else {
      // Якщо сокет ще відкривається, кладемо повідомлення у чергу
      this.sendQueue.push(payload);
    }
  }

  // Метод для ручного закриття з'єднання
  close() {
    // Вказуємо, що ми закриваємо сокет свідомо
    this.isIntentionalClose = true;
    // Перевіряємо, чи існує об'єкт сокета
    if (this.ws) {
      // Закриваємо сокет з кодом 1000 (Стандартне закриття)
      this.ws.close(1000, 'Normal Closure');
    }
  }

  // Метод для підписки на події (наприклад, client.on('chat', callback))
  on(event, callback) {
    // Перевіряємо, чи вже існує масив підписників для цієї події
    if (!this.listeners.has(event)) {
      // Якщо ні, створюємо порожній масив у Map
      this.listeners.set(event, []);
    }
    // Додаємо колбек-функцію до списку підписників
    this.listeners.get(event).push(callback);
  }

  // Приватний метод для відправки повідомлень з черги
  _flushQueue() {
    // Поки в черзі є елементи і сокет знаходиться у відкритому стані
    while (this.sendQueue.length > 0 && this.ws.readyState === WebSocket.OPEN) {
      // Витягаємо перший елемент з черги і відправляємо його
      this.ws.send(this.sendQueue.shift());
    }
  }

  // Приватний метод для розрахунку паузи та повторного підключення
  _scheduleReconnect() {
    // Збільшуємо лічильник спроб підключення
    this.reconnectAttempts++;
    // Розраховуємо паузу (1с, 2с, 4с, 8с... максимум 10 секунд)
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts - 1), this.maxReconnectDelay);
    // Виводимо в консоль час чекання до наступної спроби
    console.log(`[WSClient] Повторное подключение через ${delay}ms`);
    // Запускаємо повторне підключення через розрахований час
    setTimeout(() => this.connect(), delay);
  }

  // Приватний метод для виклику всіх підписаних функцій-слухачів
  _emit(event, payload) {
    // Отримуємо масив функцій-слухачів для даної події
    const cbs = this.listeners.get(event);
    // Якщо підписники є
    if (cbs) {
      // Викликаємо кожну функцію, передаючи їй дані
      cbs.forEach(fn => fn(payload));
    }
  }
}