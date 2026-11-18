// Статичний handler обмежує запити файлами всередині зібраного клієнта.
import { createReadStream } from 'node:fs'; // Читаємо великі файли потоком, не завантажуючи все в пам'ять.
import type { Stats } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { stat } from 'node:fs/promises'; // Перевіряємо наявність цільового файла та його тип.
import path from 'node:path'; // Безпечно розбираємо шляхи на Windows і POSIX.
import { pipeline } from 'node:stream/promises'; // Передаємо помилки й дотримуємося backpressure відповіді.
import { config } from './config.js'; // Беремо налаштовану папку Vite-збірки.

const mimeTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.woff2': 'font/woff2',
}; // Зіставляємо розширення файлів із MIME-типом браузера.

function sendText(response: ServerResponse, status: number, text: string): void {
  response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' }); // Позначаємо тіло помилки як звичайний текст.
  response.end(text); // Завершуємо відповідь без відкриття файлового потоку.
} // Завершуємо створення текстової відповіді.

export async function serveStatic(request: IncomingMessage, response: ServerResponse, pathname: string): Promise<void> {
  let decoded: string; // Оголошуємо змінну адреси поза try, щоб використати її нижче.
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    sendText(response, 400, 'Bad request');
    return;
  } // Відхиляємо некоректне percent-кодування.
  if (decoded.includes('\0') || decoded.split(/[\\/]/).includes('..')) {
    sendText(response, 400, 'Bad request');
    return;
  } // Відхиляємо сегменти виходу з папки ще до збирання шляху.
  const requested = decoded === '/' ? 'index.html' : decoded.slice(1); // Для кореня віддаємо головну сторінку клієнта.
  const filename = path.resolve(config.DIST_DIR, requested); // Обчислюємо ціль відносно папки dist.
  const relative = path.relative(config.DIST_DIR, filename); // Перевіряємо, чи не вийшов шлях за межі кореня.
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    sendText(response, 403, 'Forbidden');
    return;
  } // Забороняємо читати будь-які файли поза client/dist.
  let fileInfo: Stats; // Зберігаємо метадані лише після успішного stat.
  try {
    fileInfo = await stat(filename);
  } catch {
    sendText(response, 404, 'Not found');
    return;
  } // Повертаємо зрозумілий 404, якщо файла немає.
  if (!fileInfo.isFile()) {
    sendText(response, 404, 'Not found');
    return;
  } // Не показуємо вміст каталогів як список.
  const contentType = mimeTypes[path.extname(filename).toLowerCase()] ?? 'application/octet-stream'; // Для невідомого розширення використовуємо безпечний тип.
  response.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': fileInfo.size,
    'X-Content-Type-Options': 'nosniff',
  }); // Встановлюємо заголовки відповіді перед передаванням тіла.
  if (request.method === 'HEAD') {
    response.end();
    return;
  } // HEAD повертає такі самі заголовки, але без тіла.
  await pipeline(createReadStream(filename), response); // Передаємо файл частинами з урахуванням backpressure.
} // Завершуємо віддачу статичного файла.
