import path from "node:path";

// Центр конфігурації сервера
export const config = {
  PORT: parseInt(process.env.PORT || "3000", 10),
  HOST: process.env.HOST || "0.0.0.0",
  LOG_DIR: path.resolve(process.env.LOG_DIR || "./logs"),
  DIST_DIR: path.resolve(import.meta.dirname, "../../client/dist"),
  MAX_BODY_BYTES: 64 * 1024,
};