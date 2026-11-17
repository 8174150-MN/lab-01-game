// shared/protocol.js

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// Упаковка вхідної команди (Input) від клієнта (6 байт)
export function serializeInput(input) {
  const buffer = new ArrayBuffer(6);
  const view = new DataView(buffer);
  view.setUint8(0, 1); // Версія протоколу
  view.setUint32(1, input.seq || 0, true);

  let keys = 0;
  if (input.gas) keys |= 1;
  if (input.turn === -1) keys |= 2;
  if (input.turn === 1) keys |= 4;
  if (input.shoot) keys |= 8;

  view.setUint8(5, keys);
  return buffer;
}

// Розпаковка команди (Input) на сервері
export function deserializeInput(buffer) {
  const view = new DataView(buffer);
  const seq = view.getUint32(1, true);
  const keys = view.getUint8(5);
  return {
    seq: seq,
    gas: (keys & 1) !== 0,
    turn: (keys & 2) !== 0 ? -1 : (keys & 4) !== 0 ? 1 : 0,
    shoot: (keys & 8) !== 0,
  };
}

// Упаковка бінарного Snapshot з координатами та іменами гравців
export function serializeSnapshot(playersState) {
  const playerIds = Object.keys(playersState);
  let totalBytes = 2; // Версія (1B) + кількість гравців (1B)
  const encodedPlayers = [];

  for (const id of playerIds) {
    const p = playersState[id];
    const idBytes = encoder.encode(id);
    const nameBytes = encoder.encode(p.username || 'Гравець');
    encodedPlayers.push({ idBytes, nameBytes, p });
    // idLen(1) + id + nameLen(1) + name + X(4) + Y(4) + Angle(2) + Seq(4)
    totalBytes += 1 + idBytes.length + 1 + nameBytes.length + 4 + 4 + 2 + 4;
  }

  const buffer = new ArrayBuffer(totalBytes);
  const view = new DataView(buffer);

  view.setUint8(0, 1);
  view.setUint8(1, playerIds.length);

  let offset = 2;
  for (const item of encodedPlayers) {
    // Записуємо ID
    view.setUint8(offset, item.idBytes.length);
    offset += 1;
    new Uint8Array(buffer, offset, item.idBytes.length).set(item.idBytes);
    offset += item.idBytes.length;

    // Записуємо Ім'я (Username)
    view.setUint8(offset, item.nameBytes.length);
    offset += 1;
    new Uint8Array(buffer, offset, item.nameBytes.length).set(item.nameBytes);
    offset += item.nameBytes.length;

    // Координати, кут та lastProcessedSeq
    view.setFloat32(offset, item.p.x || 0, true);
    offset += 4;
    view.setFloat32(offset, item.p.y || 0, true);
    offset += 4;
    view.setInt16(offset, Math.round((item.p.angle || 0) * 1000), true);
    offset += 2;
    view.setUint32(offset, item.p.lastProcessedSeq || 0, true);
    offset += 4;
  }

  return buffer;
}

// Розпаковка Snapshot на клієнті
export function deserializeSnapshot(buffer) {
  const view = new DataView(buffer);
  const playerCount = view.getUint8(1);
  const players = {};

  let offset = 2;
  for (let i = 0; i < playerCount; i++) {
    // Читаємо ID
    const idLen = view.getUint8(offset);
    offset += 1;
    const id = decoder.decode(new Uint8Array(buffer, offset, idLen));
    offset += idLen;

    // Читаємо Ім'я
    const nameLen = view.getUint8(offset);
    offset += 1;
    const username = decoder.decode(new Uint8Array(buffer, offset, nameLen));
    offset += nameLen;

    // Читаємо параметри фізики
    const x = view.getFloat32(offset, true);
    offset += 4;
    const y = view.getFloat32(offset, true);
    offset += 4;
    const angle = view.getInt16(offset, true) / 1000;
    offset += 2;
    const lastProcessedSeq = view.getUint32(offset, true);
    offset += 4;

    players[id] = { x, y, angle, lastProcessedSeq, username };
  }

  return { players };
}
