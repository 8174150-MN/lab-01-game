// Цей файл містить спільний формат пакетів для браузера і Node.js.
// Багатобайтові числа скрізь записуються в порядку little-endian.

// Байти 0 і 1 у кожному пакеті позначають версію та тип повідомлення.
export const PROTOCOL_VERSION = 3;
export const MESSAGE_INPUT = 1;
export const MESSAGE_SNAPSHOT = 2;

// TextEncoder і TextDecoder доступні як у сучасному браузері, так і в Node.js.
const encoder = new TextEncoder();
const decoder = new TextDecoder();

// Пакуємо чотири кнопки та номер послідовності у сім байтів.
export function serializeInput(input) {
  const buffer = new ArrayBuffer(7);
  const view = new DataView(buffer);
  view.setUint8(0, PROTOCOL_VERSION);
  view.setUint8(1, MESSAGE_INPUT);
  view.setUint32(2, input.seq >>> 0, true);
  let flags = 0;
  if (input.gas) flags |= 1;
  if (input.turn < 0) flags |= 2;
  if (input.turn > 0) flags |= 4;
  if (input.shoot) flags |= 8;
  view.setUint8(6, flags);
  return buffer;
}

// Перетворюємо ArrayBuffer або Node Buffer на безпечний для DataView діапазон.
function asDataView(data) {
  if (data instanceof ArrayBuffer) return new DataView(data);
  if (ArrayBuffer.isView(data)) return new DataView(data.buffer, data.byteOffset, data.byteLength);
  throw new TypeError('Очікувався ArrayBuffer або Uint8Array');
}

// Розпаковуємо input і відхиляємо неправильну довжину чи версію протоколу.
export function deserializeInput(data) {
  const view = asDataView(data);
  if (view.byteLength !== 7) throw new RangeError('Неправильна довжина input');
  if (view.getUint8(0) !== PROTOCOL_VERSION || view.getUint8(1) !== MESSAGE_INPUT) {
    throw new Error('Непідтримувана версія або тип input');
  }
  const flags = view.getUint8(6);
  if (flags & 0xf0) throw new Error('Input містить невідомі прапорці');
  return {
    seq: view.getUint32(2, true),
    gas: Boolean(flags & 1),
    turn: flags & 2 ? -1 : flags & 4 ? 1 : 0,
    shoot: Boolean(flags & 8),
  };
}

// Записуємо короткий рядок як довжину в байтах і UTF-8 вміст.
function writeString(view, offset, value) {
  const encoded = encoder.encode(String(value ?? ''));
  if (encoded.byteLength > 255) throw new RangeError('Рядок задовгий для пакета');
  view.setUint8(offset, encoded.byteLength);
  new Uint8Array(view.buffer, offset + 1, encoded.byteLength).set(encoded);
  return offset + 1 + encoded.byteLength;
}

// Рахуємо розмір UTF-8 рядка разом із байтом його довжини.
function stringSize(value) {
  const size = encoder.encode(String(value ?? '')).byteLength;
  if (size > 255) throw new RangeError('Рядок задовгий для пакета');
  return size + 1;
}

// Пакуємо кораблі, кулі й астероїди в один бінарний знімок.
export function serializeSnapshot(snapshot) {
  const players = snapshot.players ?? [];
  const bullets = snapshot.bullets ?? [];
  const asteroids = snapshot.asteroids ?? [];
  const pickups = snapshot.pickups ?? [];
  if (players.length > 255 || bullets.length > 255 || asteroids.length > 255 || pickups.length > 255) {
    throw new RangeError('Забагато сутностей у знімку');
  }

  let size = 14;
  for (const player of players) {
    size += stringSize(player.id) + stringSize(player.name);
    size += 4 * 4 + 2 + 1 + 4 + 2 + 2;
  }
  for (const bullet of bullets) {
    size += stringSize(bullet.id) + stringSize(bullet.ownerId);
    size += 4 * 4 + 2;
  }
  for (const asteroid of asteroids) {
    size += stringSize(asteroid.id) + 1 + 4 * 5;
  }
  for (const pickup of pickups) {
    size += stringSize(pickup.id) + 4 * 3;
  }

  const buffer = new ArrayBuffer(size);
  const view = new DataView(buffer);
  view.setUint8(0, PROTOCOL_VERSION);
  view.setUint8(1, MESSAGE_SNAPSHOT);
  view.setUint32(2, snapshot.tick >>> 0, true);
  view.setUint32(6, snapshot.seed >>> 0, true);
  view.setUint8(10, players.length);
  view.setUint8(11, bullets.length);
  view.setUint8(12, asteroids.length);
  view.setUint8(13, pickups.length);
  let offset = 14;

  for (const player of players) {
    offset = writeString(view, offset, player.id);
    offset = writeString(view, offset, player.name);
    view.setFloat32(offset, player.x, true);
    offset += 4;
    view.setFloat32(offset, player.y, true);
    offset += 4;
    view.setFloat32(offset, player.vx, true);
    offset += 4;
    view.setFloat32(offset, player.vy, true);
    offset += 4;
    view.setInt16(offset, Math.round(player.angle * 10000), true);
    offset += 2;
    view.setUint8(offset, player.hp);
    offset += 1;
    view.setUint32(offset, player.ackSeq >>> 0, true);
    offset += 4;
    view.setUint16(offset, player.respawnTicks ?? 0, true);
    offset += 2;
    view.setUint16(offset, player.score ?? 0, true);
    offset += 2;
  }

  for (const bullet of bullets) {
    offset = writeString(view, offset, bullet.id);
    offset = writeString(view, offset, bullet.ownerId);
    view.setFloat32(offset, bullet.x, true);
    offset += 4;
    view.setFloat32(offset, bullet.y, true);
    offset += 4;
    view.setFloat32(offset, bullet.vx, true);
    offset += 4;
    view.setFloat32(offset, bullet.vy, true);
    offset += 4;
    view.setUint16(offset, Math.max(0, Math.round(bullet.ttl * 1000)), true);
    offset += 2;
  }

  for (const asteroid of asteroids) {
    offset = writeString(view, offset, asteroid.id);
    view.setUint8(offset, asteroid.homing ? 1 : 0);
    offset += 1;
    view.setFloat32(offset, asteroid.x, true);
    offset += 4;
    view.setFloat32(offset, asteroid.y, true);
    offset += 4;
    view.setFloat32(offset, asteroid.vx, true);
    offset += 4;
    view.setFloat32(offset, asteroid.vy, true);
    offset += 4;
    view.setFloat32(offset, asteroid.radius, true);
    offset += 4;
  }

  for (const pickup of pickups) {
    offset = writeString(view, offset, pickup.id);
    view.setFloat32(offset, pickup.x, true);
    offset += 4;
    view.setFloat32(offset, pickup.y, true);
    offset += 4;
    view.setFloat32(offset, pickup.radius, true);
    offset += 4;
  }

  return buffer;
}

// Читаємо довжину UTF-8 рядка, перевіряючи, що пакет не закінчився посередині.
function readString(view, offset) {
  if (offset >= view.byteLength) throw new RangeError('Пошкоджений рядок у знімку');
  const length = view.getUint8(offset);
  const start = offset + 1;
  const end = start + length;
  if (end > view.byteLength) throw new RangeError('Обрізаний рядок у знімку');
  const value = decoder.decode(new Uint8Array(view.buffer, view.byteOffset + start, length));
  return { value, offset: end };
}

// Розпаковуємо знімок і перевіряємо межі перед читанням кожного поля.
export function deserializeSnapshot(data) {
  const view = asDataView(data);
  if (view.byteLength < 14) throw new RangeError('Знімок надто короткий');
  if (view.getUint8(0) !== PROTOCOL_VERSION || view.getUint8(1) !== MESSAGE_SNAPSHOT) {
    throw new Error('Непідтримувана версія або тип знімка');
  }

  const tick = view.getUint32(2, true);
  const seed = view.getUint32(6, true);
  const playerCount = view.getUint8(10);
  const bulletCount = view.getUint8(11);
  const asteroidCount = view.getUint8(12);
  const pickupCount = view.getUint8(13);
  const players = [];
  const bullets = [];
  const asteroids = [];
  const pickups = [];
  let offset = 14;

  for (let index = 0; index < playerCount; index += 1) {
    const id = readString(view, offset);
    offset = id.offset;
    const name = readString(view, offset);
    offset = name.offset;
    if (offset + 27 > view.byteLength) throw new RangeError('Обрізаний стан корабля');
    const player = {
      id: id.value,
      name: name.value,
      x: view.getFloat32(offset, true),
      y: view.getFloat32(offset + 4, true),
      vx: view.getFloat32(offset + 8, true),
      vy: view.getFloat32(offset + 12, true),
      angle: view.getInt16(offset + 16, true) / 10000,
      hp: view.getUint8(offset + 18),
      ackSeq: view.getUint32(offset + 19, true),
      respawnTicks: view.getUint16(offset + 23, true),
      score: view.getUint16(offset + 25, true),
    };
    offset += 27;
    players.push(player);
  }

  for (let index = 0; index < bulletCount; index += 1) {
    const id = readString(view, offset);
    offset = id.offset;
    const ownerId = readString(view, offset);
    offset = ownerId.offset;
    if (offset + 18 > view.byteLength) throw new RangeError('Обрізаний стан кулі');
    bullets.push({
      id: id.value,
      ownerId: ownerId.value,
      x: view.getFloat32(offset, true),
      y: view.getFloat32(offset + 4, true),
      vx: view.getFloat32(offset + 8, true),
      vy: view.getFloat32(offset + 12, true),
      ttl: view.getUint16(offset + 16, true) / 1000,
    });
    offset += 18;
  }

  for (let index = 0; index < asteroidCount; index += 1) {
    const id = readString(view, offset);
    offset = id.offset;
    if (offset + 21 > view.byteLength) throw new RangeError('Обрізаний стан астероїда');
    const flags = view.getUint8(offset);
    asteroids.push({
      id: id.value,
      homing: Boolean(flags & 1),
      x: view.getFloat32(offset + 1, true),
      y: view.getFloat32(offset + 5, true),
      vx: view.getFloat32(offset + 9, true),
      vy: view.getFloat32(offset + 13, true),
      radius: view.getFloat32(offset + 17, true),
    });
    offset += 21;
  }

  for (let index = 0; index < pickupCount; index += 1) {
    const id = readString(view, offset);
    offset = id.offset;
    if (offset + 12 > view.byteLength) throw new RangeError('Обрізаний стан pickup');
    pickups.push({
      id: id.value,
      x: view.getFloat32(offset, true),
      y: view.getFloat32(offset + 4, true),
      radius: view.getFloat32(offset + 8, true),
    });
    offset += 12;
  }

  if (offset !== view.byteLength) throw new RangeError('У знімку є зайві байти');
  return { v: PROTOCOL_VERSION, type: 'snapshot', tick, seed, players, bullets, asteroids, pickups };
}
