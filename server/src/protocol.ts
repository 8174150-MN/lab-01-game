// Сервер зберігає коди закриття, а форму повідомлень перевіряє спільна Zod-схема.
export const CLOSE = Object.freeze({
  BAD_FORMAT: 4001,
  UNKNOWN_TYPE: 4002,
  JOIN_TIMEOUT: 4003,
  NOT_JOINED: 4004,
  ROOM_NOT_FOUND: 4005,
  RATE_LIMIT: 4006,
  ROOM_FULL: 4007,
});
