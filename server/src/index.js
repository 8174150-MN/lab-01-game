import http from "node:http";
import { mkdir } from "node:fs/promises";
import { config } from "./config.js";
import { RoomManager } from "./rooms.js";
import { setupWebSocket } from "./wsServer.js";
import { serveStatic } from "./static.js";
import { streamMatchLog } from "./logger.js";

// Кастомний клас HTTP-помилки
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Допоміжна функція відправки JSON відповіді
function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

// Безпечне зчитування тіла JSON-запиту з обмеженням за розміром (MAX_BODY_BYTES)
function readJsonBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    let tooBig = false;

    req.on("data", (chunk) => {
      if (tooBig) return;
      size += chunk.length;
      if (size > limit) {
        tooBig = true;
        reject(new HttpError(413, "Тіло запиту завелике"));
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      if (tooBig) return;
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new HttpError(400, "Некоректний JSON"));
      }
    });

    req.on("error", reject);
  });
}

// Ініціалізуємо менеджер кімнат
const roomManager = new RoomManager();

// Головна функція-обробник усіх HTTP-запитів
async function handler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const rawPath = url.pathname;
  
  // Нормалізація шляху (виправляє помилку 404): обрізає похилу риску в кінці (/api/rooms/ -> /api/rooms)
  const pathname = (rawPath.length > 1 && rawPath.endsWith("/")) ? rawPath.slice(0, -1) : rawPath;

  // Налаштування CORS для сумісності з розробницьким сервером Vite
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  // Health-check маршрут
  if (pathname === "/health" && req.method === "GET") {
    return sendJson(res, 200, { status: "ok", uptime: process.uptime() });
  }

  // REST API: Отримання та створення кімнат
  if (pathname === "/api/rooms") {
    if (req.method === "GET") {
      const list = roomManager.list();
      return sendJson(res, 200, list);
    }
    if (req.method === "POST") {
      const body = await readJsonBody(req, config.MAX_BODY_BYTES);
      const name = (body && typeof body.name === "string" && body.name.trim())
        ? body.name.trim()
        : "Нова кімната";
      const room = roomManager.create(name);
      return sendJson(res, 201, room);
    }
    throw new HttpError(405, "Метод не дозволений");
  }

  // REST API: Перегляд / потокове відтворення логу матчу
  const replayMatch = pathname.match(/^\/api\/rooms\/([^\/]+)\/replay$/);
  if (replayMatch && req.method === "GET") {
    const roomId = replayMatch[1];
    await streamMatchLog(roomId, res);
    return;
  }

  // Усі інші API-запити, яких немає, повертають 404
  if (pathname.startsWith("/api/")) {
    throw new HttpError(404, "Не знайдено");
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    throw new HttpError(405, "Метод не дозволений");
  }

  // Обслуговування статичних файлів клієнта
  return serveStatic(req, res, pathname);
}

// Створення HTTP-сервера
const server = http.createServer((req, res) => {
  handler(req, res).catch((err) => {
    const status = err instanceof HttpError ? err.status : 500;
    if (status === 500) console.error("[Server Error]", err);
    if (res.headersSent) return res.destroy();
    sendJson(res, status, { error: status === 500 ? "Внутрішня помилка" : err.message });
  });
});

server.on("error", (err) => {
  console.error("Помилка сервера:", err.message);
  process.exit(1);
});

// Налаштування WebSocket і створення папки логів
const { closeAll } = setupWebSocket(server, roomManager);
await mkdir(config.LOG_DIR, { recursive: true });

// Запуск прослуховування порту
server.listen(config.PORT, config.HOST, () => {
  console.log(`Сервер: http://${config.HOST}:${config.PORT}`);
});

// Реалізація Graceful Shutdown (плавного вимкнення при Ctrl + C)
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Отримано ${signal}, вимикаюсь...`);
  closeAll(); // Закриваємо всі WebSocket з'єднання
  server.close(() => {
    console.log("Усі з'єднання закрито");
    process.exit(0);
  });
  server.closeIdleConnections();
  setTimeout(() => server.closeAllConnections(), 5000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));