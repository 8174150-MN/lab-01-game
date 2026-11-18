// Сервер перевіряє текстові повідомлення до того, як їх торкнеться логіка гри.
export const PROTOCOL_VERSION = 1;
export const CLOSE = Object.freeze({
  BAD_FORMAT: 4001,
  UNKNOWN_TYPE: 4002,
  JOIN_TIMEOUT: 4003,
  NOT_JOINED: 4004,
  ROOM_NOT_FOUND: 4005,
  RATE_LIMIT: 4006,
  ROOM_FULL: 4007,
});

// Повертаємо помилку у спільному для всіх перевірок форматі.
function failure(code, reason) {
  return { ok: false, code, reason };
}

// Повертаємо повідомлення лише після перевірки кожного поля.
function success(message) {
  return { ok: true, message };
}

// Забороняємо непередбачені поля, щоб клієнт не підсовував координати корабля.
function hasOnlyKeys(message, allowed) {
  return Object.keys(message).every((key) => allowed.includes(key));
}

// Перевіряємо рядкове поле та прибираємо пробіли по краях.
function cleanString(value, min, max) {
  if (typeof value !== 'string') return null;
  const result = value.trim();
  return result.length >= min && result.length <= max ? result : null;
}

// Розбираємо, перевіряємо версію й тип одного JSON-повідомлення.
export function validateMessage(raw) {
  let message;
  try {
    message = JSON.parse(raw);
  } catch {
    return failure(CLOSE.BAD_FORMAT, 'invalid JSON');
  }
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    return failure(CLOSE.BAD_FORMAT, 'message must be an object');
  }
  if (message.v !== PROTOCOL_VERSION) return failure(CLOSE.BAD_FORMAT, 'unsupported protocol version');
  if (typeof message.type !== 'string') return failure(CLOSE.BAD_FORMAT, 'type must be a string');

  if (message.type === 'join') {
    if (!hasOnlyKeys(message, ['v', 'type', 'room', 'name', 'format'])) {
      return failure(CLOSE.BAD_FORMAT, 'unexpected join field');
    }
    const room = cleanString(message.room, 1, 64);
    const name = cleanString(message.name, 1, 24);
    const format = message.format ?? 'binary';
    if (!room || !name || !['binary', 'json'].includes(format)) {
      return failure(CLOSE.BAD_FORMAT, 'invalid join fields');
    }
    return success({ type: 'join', room, name, format });
  }

  if (message.type === 'chat') {
    if (!hasOnlyKeys(message, ['v', 'type', 'text'])) return failure(CLOSE.BAD_FORMAT, 'unexpected chat field');
    const text = cleanString(message.text, 1, 500);
    if (!text) return failure(CLOSE.BAD_FORMAT, 'invalid chat text');
    return success({ type: 'chat', text });
  }

  if (message.type === 'input') {
    if (!hasOnlyKeys(message, ['v', 'type', 'seq', 'gas', 'turn', 'shoot'])) {
      return failure(CLOSE.BAD_FORMAT, 'unexpected input field');
    }
    const validSequence = Number.isInteger(message.seq) && message.seq >= 0 && message.seq <= 0xffffffff;
    const validButtons = typeof message.gas === 'boolean' && typeof message.shoot === 'boolean';
    if (!validSequence || !validButtons || ![-1, 0, 1].includes(message.turn)) {
      return failure(CLOSE.BAD_FORMAT, 'invalid input fields');
    }
    return success({
      type: 'input',
      seq: message.seq,
      gas: message.gas,
      turn: message.turn,
      shoot: message.shoot,
    });
  }

  if (message.type === 'ping') {
    if (!hasOnlyKeys(message, ['v', 'type', 'sentAt']) || !Number.isFinite(message.sentAt)) {
      return failure(CLOSE.BAD_FORMAT, 'invalid ping');
    }
    return success({ type: 'ping', sentAt: message.sentAt });
  }

  return failure(CLOSE.UNKNOWN_TYPE, 'unknown message type');
}
