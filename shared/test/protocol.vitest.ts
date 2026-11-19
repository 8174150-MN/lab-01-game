import { describe, expect, it } from 'vitest'; // Перевіряємо формат повідомлень і бінарний декодер.
import {
  binaryCodec,
  deserializeInput,
  deserializeSnapshot,
  entityPosition,
  jsonCodec,
  parseClientMessage,
  parseServerMessage,
  serializeInput,
  serializeSnapshot,
} from '../protocol.js'; // Викликаємо публічний інтерфейс протоколу.
import { asEntityId, asSeq, asTick, type Snapshot } from '../types.js'; // Брендуємо значення тестового кадру.

// Створюємо знімок з одним записом кожного виду сутності.
function makeSnapshot(): Snapshot {
  const id = asEntityId('entity-1'); // Даємо всім тестовим сутностям короткий перевірений ID.
  const player = {
    kind: 'ship' as const,
    id,
    name: 'Pilot',
    x: 10,
    y: 20,
    vx: 1,
    vy: 2,
    angle: 0.12345,
    hp: 3,
    ackSeq: asSeq(4),
    respawnTicks: 0,
    score: 5,
  }; // Описуємо гравця за схемою Lab 5.
  return {
    v: 3,
    type: 'snapshot',
    tick: asTick(8),
    seed: 9,
    players: [player],
    bullets: [{ kind: 'bullet', id: asEntityId('bullet-1'), ownerId: id, x: 1, y: 2, vx: 3, vy: 4, ttl: 0.5 }],
    asteroids: [
      { kind: 'asteroid', id: asEntityId('asteroid-1'), x: 30, y: 40, vx: -1, vy: 2, radius: 18, homing: true },
    ],
    pickups: [{ kind: 'pickup', id: asEntityId('pickup-1'), x: 50, y: 60, radius: 8 }],
  }; // Повертаємо повний кадр із фіксованими полями.
} // Завершуємо фабрику тестового знімка.

// Створюємо лише заголовок кадру для тестів обрізаного запису.
function makeHeader(players = 0, bullets = 0, asteroids = 0, pickups = 0): ArrayBuffer {
  const buffer = new ArrayBuffer(14); // Заголовок займає рівно чотирнадцять байтів.
  const view = new DataView(buffer); // Пишемо поля у форматі DataView.
  view.setUint8(0, 3); // Записуємо версію бінарного протоколу.
  view.setUint8(1, 2); // Записуємо тип snapshot.
  view.setUint8(10, players); // Записуємо кількість кораблів.
  view.setUint8(11, bullets); // Записуємо кількість куль.
  view.setUint8(12, asteroids); // Записуємо кількість астероїдів.
  view.setUint8(13, pickups); // Записуємо кількість pickup.
  return buffer; // Повертаємо буфер без жодного запису сутності.
} // Завершуємо створення заголовка.

describe('JSON message validation', () => {
  it('accepts every supported client message and handles malformed input', () => {
    const messages = [
      { v: 1, type: 'join', room: 'default_room', name: 'Pilot' },
      { v: 1, type: 'input', seq: 2, gas: true, turn: -1, shoot: false },
      { v: 1, type: 'chat', text: 'hello' },
      { v: 1, type: 'ping', sentAt: 10 },
    ]; // Перебираємо join, input, chat і ping.
    for (const message of messages) expect(parseClientMessage(JSON.stringify(message)).ok).toBe(true); // Валідні мережеві команди проходять Zod.
    expect(parseClientMessage('not-json').ok).toBe(false); // Пошкоджений JSON перетворюється на помилку формату.
    expect(parseClientMessage({ v: 1, type: 'teleport' })).toMatchObject({ ok: false, kind: 'unknown-type' }); // Невідомий тип розпізнається окремо.
    expect(parseClientMessage(42)).toMatchObject({ ok: false, kind: 'bad-format' }); // Необ'єктне повідомлення не проходить схему.
    expect(parseClientMessage(null)).toMatchObject({ ok: false, kind: 'bad-format' }); // null не вважається об'єктом повідомлення.
    expect(parseClientMessage([])).toMatchObject({ ok: false, kind: 'bad-format' }); // Масив не проходить перевірку звичайного запису.
    expect(parseClientMessage({ v: 1, type: 'chat', text: 'hello', extra: true })).toMatchObject({
      ok: false,
      kind: 'bad-format',
    }); // Сувора схема забороняє зайві поля.
  }); // Завершуємо перевірку вхідних JSON-повідомлень.

  it('accepts and rejects server messages through the runtime schema', () => {
    const snapshot = makeSnapshot(); // Готуємо коректний тип server-to-client.
    expect(parseServerMessage(snapshot).ok).toBe(true); // Валідний знімок приймається.
    expect(parseServerMessage({ type: 'snapshot', v: 3, players: [] }).ok).toBe(false); // Неповний знімок відхиляється.
  }); // Завершуємо перевірку server schema.
}); // Завершуємо перевірки JSON.

describe('binary input validation', () => {
  it('decodes ArrayBuffer and typed-array views and rejects malformed frames', () => {
    const input = { seq: asSeq(7), gas: true, turn: -1 as const, shoot: true }; // Формуємо команду з прапорцями.
    const frame = serializeInput(input); // Кодуємо команду у форматі семи байтів.
    expect(deserializeInput(frame)).toEqual(input); // Приймаємо звичайний ArrayBuffer.
    expect(deserializeInput(new Uint8Array(frame))).toEqual(input); // Приймаємо типізований view над тими самими байтами.
    expect(() => deserializeInput(new ArrayBuffer(6))).toThrow(RangeError); // Короткий кадр відхиляється за довжиною.
    const wrongVersion = frame.slice(0); // Копіюємо валідний кадр для пошкодження версії.
    new DataView(wrongVersion).setUint8(0, 1); // Змінюємо байт версії.
    expect(() => deserializeInput(wrongVersion)).toThrow('Непідтримувана версія або тип input'); // Невірна версія безпечно відхиляється.
    const bothTurns = frame.slice(0); // Копіюємо кадр для тесту взаємовиключних прапорців.
    new DataView(bothTurns).setUint8(6, 6); // Одночасно вмикаємо лівий і правий поворот.
    expect(() => deserializeInput(bothTurns)).toThrow('Input містить невідомі прапорці'); // Конфлікт кнопок відхиляється.
    const unknownFlag = frame.slice(0); // Копіюємо кадр для невідомого біта.
    new DataView(unknownFlag).setUint8(6, 16); // Вмикаємо прапорець, якого немає у форматі.
    expect(() => deserializeInput(unknownFlag)).toThrow('Input містить невідомі прапорці'); // Невідомі біти не ігноруються.
    expect(() => deserializeInput('not bytes')).toThrow(TypeError); // Значення іншого типу не передається у DataView.
  }); // Завершуємо перевірку decoder input.
}); // Завершуємо бінарні input-тести.

describe('binary snapshot validation', () => {
  it('round-trips every entity kind through both codec adapters', () => {
    const snapshot = makeSnapshot(); // Беремо кадр із гравцем, кулею, астероїдом і бонусом.
    const binary = binaryCodec.encode(snapshot); // Кодуємо через типізований binary codec.
    const decoded = binaryCodec.decode(new Uint8Array(binary)); // Декодуємо з view, якого може передати WebSocket.
    expect(decoded.players[0]?.angle).toBe(Math.round(0.12345 * 10000) / 10000); // Кут зберігається з форматом Int16.
    expect(decoded.bullets[0]?.ttl).toBe(0.5); // Поле кулі відновлюється з мілісекунд.
    expect(decoded.asteroids[0]?.homing).toBe(true); // Біт homing декодується в boolean.
    expect(decoded.pickups[0]?.radius).toBe(8); // Pickup зберігає свій радіус.
    expect(jsonCodec.decode(jsonCodec.encode(snapshot))).toEqual(snapshot); // JSON codec відтворює всі поля точніше за binary.
    expect(jsonCodec.decode(snapshot)).toEqual(snapshot); // Codec також приймає вже розібраний об'єкт.
  }); // Завершуємо перевірку round-trip обох кодеків.

  it('rejects oversize, non-finite, and truncated snapshots', () => {
    const snapshot = makeSnapshot(); // Беремо валідний кадр як основу для мутацій.
    const oversizePlayers = Array.from({ length: 256 }, () => snapshot.players[0]).filter(
      (player) => player !== undefined,
    ); // Формуємо кількість гравців понад поле uint8.
    expect(() => serializeSnapshot({ ...snapshot, players: oversizePlayers })).toThrow('Забагато сутностей у знімку'); // Перевищення ліміту зупиняється до запису.
    const invalidNumber = { ...snapshot, players: [{ ...snapshot.players[0]!, x: Number.POSITIVE_INFINITY }] }; // Підставляємо нескінченну координату.
    expect(() => serializeSnapshot(invalidNumber)).toThrow('Некоректне числове поле: player.x'); // f32 не може кодувати нечисловий стан.
    const tooLongId = { ...snapshot, players: [{ ...snapshot.players[0]!, id: asEntityId('x'.repeat(256)) }] }; // Перевищуємо один байт довжини UTF-8 рядка.
    expect(() => serializeSnapshot(tooLongId)).toThrow('Рядок задовгий для пакета'); // Довгий ID відхиляється до алокації кадру.
    expect(() => deserializeSnapshot('text')).toThrow(TypeError); // Непідтримуваний контейнер відхиляється.
    expect(() => deserializeSnapshot(new ArrayBuffer(13))).toThrow('Знімок надто короткий'); // Заголовок перевіряється до читання.
    const wrongVersion = serializeSnapshot(snapshot); // Створюємо валідний кадр.
    new DataView(wrongVersion).setUint8(0, 0); // Пошкоджуємо його версію.
    expect(() => deserializeSnapshot(wrongVersion)).toThrow('Непідтримувана версія або тип знімка'); // Декодер не приймає інший формат.
    const trailing = new Uint8Array(15); // Додаємо зайвий байт після порожнього кадру.
    trailing.set(
      new Uint8Array(serializeSnapshot({ ...snapshot, players: [], bullets: [], asteroids: [], pickups: [] })),
    ); // Копіюємо коректний порожній заголовок.
    expect(() => deserializeSnapshot(trailing)).toThrow('У знімку є зайві байти'); // Декодер перевіряє точну довжину.
  }); // Завершуємо перевірку меж кадру.

  it('reports malformed strings, fields, and records as catchable decoder errors', () => {
    const emptyHeader = makeHeader(1); // Header обіцяє корабель, але після нього немає рядка.
    expect(() => deserializeSnapshot(emptyHeader)).toThrow('Пошкоджений рядок у знімку'); // Зчитувач перевіряє, що offset ще в кадрі.
    const cutString = new Uint8Array(15); // Залишаємо місце лише для довжини ID.
    cutString.set(new Uint8Array(makeHeader(1))); // Записуємо початковий header.
    cutString[14] = 4; // Оголошуємо ID довшим, ніж наявні байти.
    expect(() => deserializeSnapshot(cutString)).toThrow('Обрізаний рядок у знімку'); // Декодер виявляє недописаний UTF-8 рядок.
    const cutShip = new Uint8Array(18); // Додаємо ID і ім'я, але не поля корабля.
    cutShip.set(new Uint8Array(makeHeader(1))); // Позначаємо один корабель у header.
    cutShip[14] = 1; // ID має один байт.
    cutShip[15] = 112; // ID — літера p.
    cutShip[16] = 1; // Ім'я має один байт.
    cutShip[17] = 80; // Ім'я — літера P.
    expect(() => deserializeSnapshot(cutShip)).toThrow('Обрізаний стан корабля'); // Декодер перевіряє сталу частину запису.
    const nonFinite = serializeSnapshot({ ...makeSnapshot(), bullets: [], asteroids: [], pickups: [] }); // Кодуємо один корабель.
    new DataView(nonFinite).setFloat32(29, Number.POSITIVE_INFINITY, true); // Підміняємо його X на нескінченність після UTF-8 рядків.
    expect(() => deserializeSnapshot(nonFinite)).toThrow('У знімку є нескінченне або NaN-число'); // Числа перевіряються до стану гри.
    const invalidAsteroid = serializeSnapshot({ ...makeSnapshot(), players: [], bullets: [], pickups: [] }); // Кодуємо один астероїд.
    new DataView(invalidAsteroid).setUint8(25, 2); // Після десятибайтового ID вмикаємо невідомий біт астероїда.
    expect(() => deserializeSnapshot(invalidAsteroid)).toThrow('Астероїд містить невідомі прапорці'); // Невідомі прапорці відхиляються.
    const cutPickup = serializeSnapshot({ ...makeSnapshot(), players: [], bullets: [], asteroids: [] }); // Кодуємо один pickup.
    expect(() => deserializeSnapshot(cutPickup.slice(0, cutPickup.byteLength - 1))).toThrow(); // Обрізаний останній запис не читається частково.
  }); // Завершуємо перевірки безпечної відмови.

  it('rejects non-snapshot JSON messages and exposes positions for every kind', () => {
    const snapshot = makeSnapshot(); // Готуємо стан для codec і entityPosition.
    const player = snapshot.players[0]; // Беремо корабель для відповіді joined_success.
    if (!player) throw new Error('Snapshot fixture needs a player'); // Перериваємо тест, якщо фабрика змінилася.
    const roomPlayers = [{ id: player.id, name: player.name }]; // Формуємо учасника для roster і welcome.
    const joined = {
      v: 1,
      type: 'joined_success',
      roomId: 'room-1',
      playerId: player.id,
      format: 'binary',
      seed: 9,
      tickRate: 30,
      arena: { width: 1280, height: 720 },
      state: player,
      snapshot,
      players: roomPlayers,
    }; // Описуємо коректне підтвердження входу.
    const otherMessages = [
      joined,
      { v: 1, type: 'roster', roomId: 'room-1', players: roomPlayers },
      { v: 1, type: 'chat', sender: 'Pilot', text: 'hi', at: 'now' },
      { v: 1, type: 'pong', sentAt: 1 },
    ]; // Перебираємо всі серверні повідомлення, які не є snapshot.
    for (const message of otherMessages)
      expect(() => jsonCodec.decode(JSON.stringify(message))).toThrow('Очікувався знімок світу'); // Codec коректно розбирає тип, але не видає його за стан світу.
    expect(() => jsonCodec.decode('{')).toThrow(); // Синтаксично пошкоджений JSON не маскується.
    expect(binaryCodec.decode(binaryCodec.encode(snapshot)).tick).toBe(snapshot.tick); // Binary codec повертає branded номер кроку.
    expect(entityPosition(snapshot.players[0]!)).toEqual({ x: 10, y: 20 }); // Витягаємо координати корабля.
    expect(entityPosition(snapshot.bullets[0]!)).toEqual({ x: 1, y: 2 }); // Витягаємо координати кулі.
    expect(entityPosition(snapshot.asteroids[0]!)).toEqual({ x: 30, y: 40 }); // Витягаємо координати астероїда.
    expect(entityPosition(snapshot.pickups[0]!)).toEqual({ x: 50, y: 60 }); // Витягаємо координати бонусу.
  }); // Завершуємо перевірки codec та union.
}); // Завершуємо перевірки протоколу.
