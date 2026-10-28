import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { config } from "./config.js";

// Словник типів файлів (MIME types)
const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

function sendText(res, status, text) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(text);
}

// Модуль віддачі статичних файлів із захистом від Path Traversal
export async function serveStatic(req, res, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return sendText(res, 400, "Bad request");
  }

  // Захист: блокуємо спроби вийти з робочої директорії за допомогою ".." або "\0"
  if (decoded.includes("\0") || decoded.split(/[\\/]/).includes("..")) {
    return sendText(res, 400, "Bad request");
  }

  // Якщо запит на "/", віддаємо index.html
  const relative = decoded === "/" ? "index.html" : decoded.slice(1);
  const filePath = path.join(config.DIST_DIR, relative);

  // Перевірка: файл має перебувати суворо всередині папки dist
  if (!filePath.startsWith(config.DIST_DIR + path.sep)) {
    return sendText(res, 403, "Forbidden");
  }

  let info;
  try {
    info = await stat(filePath);
  } catch {
    return sendText(res, 404, "Not found");
  }

  if (!info.isFile()) {
    return sendText(res, 404, "Not found");
  }

  // Встановлюємо відповідний MIME type та розмір
  const type = MIME_TYPES[path.extname(filePath)] ?? "application/octet-stream";
  res.writeHead(200, {
    "Content-Type": type,
    "Content-Length": info.size,
  });

  // Передаємо файл через потік pipeline
  await pipeline(createReadStream(filePath), res);
}