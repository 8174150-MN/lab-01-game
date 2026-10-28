// session.js: одна ігрова сесія = одне з’єднання з однією кімнатою.
import { createConnection } from "./connection.js"; // твоя обгортка сокета

// startSession: викликається, коли гравець натиснув Join у лобі.
// Приймає один об’єкт з полями, тож порядок аргументів не важливий.
export function startSession({ roomId, name, onRoster, onChat, onStatus }) {
  const scheme = location.protocol === "https:" ? "wss" : "ws"; // на https потрібен захищений wss
  const conn = createConnection(`${scheme}://${location.host}/ws`); // адреса сокета; Vite проксує /ws на сервер

  // setHello: що слати першим після КОЖНОГО (пере)підключення. Сервер чекає join за 5 с.
  conn.setHello(() => ({ type: "join", room: roomId, name })); // v додасть сама обгортка

  conn.onStatus((state, code) => onStatus?.(state, code)); // ?. означає: викликати, лише якщо функцію передали
  conn.on("roster", (msg) => onRoster?.(msg)); // сервер надіслав оновлений список гравців
  conn.on("chat", (msg) => onChat?.(msg)); // у кімнаті з’явилось повідомлення чату

  conn.connect(); // запускаємо підключення

  // Повертаємо те, чим інтерфейс керуватиме сесією.
  return {
    sendChat(text) { conn.send({ type: "chat", text }); }, // надіслати повідомлення в чат
    leave() { conn.close(); }, // вийти: закриває сокет і вимикає перепідключення
  };
}