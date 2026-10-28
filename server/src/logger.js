import { createWriteStream, createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { config } from "./config.js";

// Логер подій матчу: створює потік запису у файл match-<roomId>.ndjson
export function createMatchLogger(roomId) {
  const logFilePath = path.join(config.LOG_DIR, `match-${roomId}.ndjson`);
  
  // Прапор 'a' (append) гарантує дописування нових рядків у кінець файла без перезапису
  const stream = createWriteStream(logFilePath, { flags: "a" });

  return {
    // Запис події у форматі NDJSON (один JSON-об'єкт на рядок з \n в кінці)
    log(event, data) {
      const record = JSON.stringify({
        timestamp: new Date().toISOString(),
        event,
        data,
      }) + "\n";
      stream.write(record);
    },
    // Закриття потоку запису при видаленні кімнати
    close() {
      stream.end();
    },
  };
}

// Потокова віддача логів матчу через HTTP (вимога лабораторної щодо Streams)
export async function streamMatchLog(roomId, res) {
  const logFilePath = path.join(config.LOG_DIR, `match-${roomId}.ndjson`);
  try {
    const info = await stat(logFilePath);
    if (!info.isFile()) {
      res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ error: "Match log not found" }));
    }
    
    // Заголовки для NDJSON-формату
    res.writeHead(200, {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Content-Length": info.size,
    });
    
    // Потокове зчитування через pipeline: зчитує файл шматками й надсилає клієнту
    await pipeline(createReadStream(logFilePath), res);
  } catch {
    res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "Match log not found" }));
  }
}