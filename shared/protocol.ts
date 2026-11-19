// Один модуль визначає JSON-повідомлення і бінарний формат для браузера та Node.js.
import { z } from 'zod';
import {
  asEntityId,
  asSeq,
  asTick,
  type AsteroidEntity,
  type BulletEntity,
  type EntityId,
  type InputCommand,
  type PickupEntity,
  type Seq,
  type ShipEntity,
  type Snapshot,
  type Tick,
} from './types.js';

// Бінарна версія окрема від читабельних JSON-повідомлень.
export const PROTOCOL_VERSION = 3;
export const JSON_PROTOCOL_VERSION = 1;
export const MESSAGE_INPUT = 1;
export const MESSAGE_SNAPSHOT = 2;

// Перевіряємо безпечні примітиви й перетворюємо їх на branded-типи після runtime-валідації.
const uint32Schema = z.number().int().min(0).max(0xffffffff);
const entityIdSchema = z.string().min(1).max(255).transform(asEntityId);
const tickSchema = uint32Schema.transform(asTick);
const seqSchema = uint32Schema.transform(asSeq);
const turnSchema = z.union([z.literal(-1), z.literal(0), z.literal(1)]);

// Zod-схеми приймають лише явно дозволені поля; типи нижче автоматично виведені зі схем.
export const clientMessageSchema = z.discriminatedUnion('type', [
  z
    .object({
      v: z.literal(JSON_PROTOCOL_VERSION),
      type: z.literal('join'),
      room: z.string().trim().min(1).max(64),
      name: z.string().trim().min(1).max(24),
      format: z.enum(['binary', 'json']).default('binary'),
    })
    .strict(),
  z
    .object({
      v: z.literal(JSON_PROTOCOL_VERSION),
      type: z.literal('input'),
      seq: seqSchema,
      gas: z.boolean(),
      turn: turnSchema,
      shoot: z.boolean(),
    })
    .strict(),
  z
    .object({ v: z.literal(JSON_PROTOCOL_VERSION), type: z.literal('chat'), text: z.string().trim().min(1).max(500) })
    .strict(),
  z
    .object({ v: z.literal(JSON_PROTOCOL_VERSION), type: z.literal('ping'), sentAt: z.number().finite().nonnegative() })
    .strict(),
]);

export type ClientMessage = z.infer<typeof clientMessageSchema>;
export type JoinMessage = Extract<ClientMessage, { type: 'join' }>;
export type ChatMessage = Extract<ClientMessage, { type: 'chat' }>;
export type InputMessage = Extract<ClientMessage, { type: 'input' }>;
export type PingMessage = Extract<ClientMessage, { type: 'ping' }>;

// Схеми знімка фіксують kind і форму кожного типу сутності.
const shipSchema = z
  .object({
    kind: z.literal('ship'),
    id: entityIdSchema,
    name: z.string().min(1).max(255),
    x: z.number().finite(),
    y: z.number().finite(),
    vx: z.number().finite(),
    vy: z.number().finite(),
    angle: z.number().finite().min(-Math.PI).max(Math.PI),
    hp: z.number().int().min(0).max(255),
    ackSeq: seqSchema,
    respawnTicks: z.number().int().min(0).max(0xffff),
    score: z.number().int().min(0).max(0xffff),
  })
  .strict();

const bulletSchema = z
  .object({
    kind: z.literal('bullet'),
    id: entityIdSchema,
    ownerId: entityIdSchema,
    x: z.number().finite(),
    y: z.number().finite(),
    vx: z.number().finite(),
    vy: z.number().finite(),
    ttl: z.number().finite().min(0).max(65.535),
  })
  .strict();

const asteroidSchema = z
  .object({
    kind: z.literal('asteroid'),
    id: entityIdSchema,
    x: z.number().finite(),
    y: z.number().finite(),
    vx: z.number().finite(),
    vy: z.number().finite(),
    radius: z.number().finite().positive(),
    homing: z.boolean(),
  })
  .strict();

const pickupSchema = z
  .object({
    kind: z.literal('pickup'),
    id: entityIdSchema,
    x: z.number().finite(),
    y: z.number().finite(),
    radius: z.number().finite().positive(),
  })
  .strict();

export const snapshotSchema = z
  .object({
    v: z.union([z.literal(JSON_PROTOCOL_VERSION), z.literal(PROTOCOL_VERSION)]),
    type: z.literal('snapshot'),
    tick: tickSchema,
    seed: uint32Schema,
    players: z.array(shipSchema).max(255),
    bullets: z.array(bulletSchema).max(255),
    asteroids: z.array(asteroidSchema).max(255),
    pickups: z.array(pickupSchema).max(255),
  })
  .strict();

// Кожен JSON-тип, який сервер надсилає браузеру, має runtime-схему.
export const serverMessageSchema = z.discriminatedUnion('type', [
  snapshotSchema,
  z
    .object({
      v: z.literal(JSON_PROTOCOL_VERSION),
      type: z.literal('joined_success'),
      roomId: z.string().min(1).max(64),
      playerId: entityIdSchema,
      format: z.enum(['binary', 'json']),
      seed: uint32Schema,
      tickRate: z.literal(30),
      arena: z.object({ width: z.number().positive(), height: z.number().positive() }).strict(),
      state: shipSchema,
      snapshot: snapshotSchema,
      players: z.array(z.object({ id: entityIdSchema, name: z.string().min(1).max(24) }).strict()).max(100),
    })
    .strict(),
  z
    .object({
      v: z.literal(JSON_PROTOCOL_VERSION),
      type: z.literal('roster'),
      roomId: z.string().min(1).max(64),
      players: z.array(z.object({ id: entityIdSchema, name: z.string().min(1).max(24) }).strict()).max(100),
    })
    .strict(),
  z
    .object({
      v: z.literal(JSON_PROTOCOL_VERSION),
      type: z.literal('chat'),
      sender: z.string().min(1).max(24),
      text: z.string().min(1).max(500),
      at: z.string(),
    })
    .strict(),
  z
    .object({ v: z.literal(JSON_PROTOCOL_VERSION), type: z.literal('pong'), sentAt: z.number().finite().nonnegative() })
    .strict(),
]);

export type ServerMessage = z.infer<typeof serverMessageSchema>;
export type JoinedMessage = Extract<ServerMessage, { type: 'joined_success' }>;
export type SnapshotMessage = z.infer<typeof snapshotSchema>;

export type ParseResult<Value> =
  | { readonly ok: true; readonly message: Value }
  | { readonly ok: false; readonly kind: 'bad-format' | 'unknown-type'; readonly reason: string };

// Не довіряємо JSON.parse: його результат лишається unknown до успішного safeParse.
function parseJsonText(text: string): ParseResult<unknown> {
  try {
    return { ok: true, message: JSON.parse(text) };
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : 'invalid JSON';
    return { ok: false, kind: 'bad-format', reason };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Перевіряємо і текстовий JSON, і вже розібраний об'єкт, не кидаючи помилок назовні.
export function parseClientMessage(data: unknown): ParseResult<ClientMessage> {
  const json: ParseResult<unknown> = typeof data === 'string' ? parseJsonText(data) : { ok: true, message: data };
  if (!json.ok) return json;
  const parsed = clientMessageSchema.safeParse(json.message);
  if (parsed.success) return { ok: true, message: parsed.data };
  const messageType = isRecord(json.message) ? json.message.type : undefined;
  const knownTypes = ['join', 'input', 'chat', 'ping'];
  if (typeof messageType === 'string' && !knownTypes.includes(messageType)) {
    return { ok: false, kind: 'unknown-type', reason: 'unknown message type' };
  }
  return { ok: false, kind: 'bad-format', reason: parsed.error.issues[0]?.message ?? 'invalid message' };
}

// Перевіряємо повідомлення сервера після JSON.parse на стороні браузера.
export function parseServerMessage(data: unknown): ParseResult<ServerMessage> {
  const parsed = serverMessageSchema.safeParse(data);
  if (parsed.success) return { ok: true, message: parsed.data };
  return { ok: false, kind: 'bad-format', reason: parsed.error.issues[0]?.message ?? 'invalid server message' };
}

// Пакуємо input у сім байтів: версія, тип, seq little-endian і прапорці кнопок.
export function serializeInput(input: InputCommand): ArrayBuffer {
  const buffer = new ArrayBuffer(7);
  const view = new DataView(buffer);
  view.setUint8(0, PROTOCOL_VERSION);
  view.setUint8(1, MESSAGE_INPUT);
  view.setUint32(2, input.seq, true);
  let flags = 0;
  if (input.gas) flags |= 1;
  if (input.turn < 0) flags |= 2;
  if (input.turn > 0) flags |= 4;
  if (input.shoot) flags |= 8;
  view.setUint8(6, flags);
  return buffer;
}

// Приймаємо тільки ArrayBuffer або його view, наприклад Node Buffer.
function asDataView(data: unknown): DataView {
  if (data instanceof ArrayBuffer) return new DataView(data);
  if (ArrayBuffer.isView(data)) return new DataView(data.buffer, data.byteOffset, data.byteLength);
  throw new TypeError('Очікувався ArrayBuffer або Uint8Array');
}

// Декодуємо input і перевіряємо довжину, версію та всі бітові прапорці.
export function deserializeInput(data: unknown): InputCommand {
  const view = asDataView(data);
  if (view.byteLength !== 7) throw new RangeError('Неправильна довжина input');
  if (view.getUint8(0) !== PROTOCOL_VERSION || view.getUint8(1) !== MESSAGE_INPUT) {
    throw new Error('Непідтримувана версія або тип input');
  }
  const flags = view.getUint8(6);
  if ((flags & 0xf0) !== 0 || (flags & 6) === 6) throw new Error('Input містить невідомі прапорці');
  return {
    seq: asSeq(view.getUint32(2, true)),
    gas: Boolean(flags & 1),
    turn: flags & 2 ? -1 : flags & 4 ? 1 : 0,
    shoot: Boolean(flags & 8),
  };
}

// Кодуємо рядок UTF-8 з одним байтом довжини та обмежуємо його місткістю протоколу.
function writeString(view: DataView, offset: number, value: string): number {
  const encoded = new TextEncoder().encode(value);
  if (encoded.byteLength > 255) throw new RangeError('Рядок задовгий для пакета');
  view.setUint8(offset, encoded.byteLength);
  new Uint8Array(view.buffer, offset + 1, encoded.byteLength).set(encoded);
  return offset + 1 + encoded.byteLength;
}

function stringSize(value: string): number {
  const size = new TextEncoder().encode(value).byteLength;
  if (size > 255) throw new RangeError('Рядок задовгий для пакета');
  return size + 1;
}

// Переконуємося, що f32 поміститься в пакет і не перетвориться на Infinity.
function assertFinite(value: number, field: string): void {
  if (!Number.isFinite(value) || Math.abs(value) > 3.402823466e38) {
    throw new RangeError('Некоректне числове поле: ' + field);
  }
}

// Пакуємо typed snapshot у попередній бінарний layout, не змінюючи формат Lab 5.
export function serializeSnapshot(snapshot: Snapshot): ArrayBuffer {
  const { players, bullets, asteroids, pickups } = snapshot;
  if (players.length > 255 || bullets.length > 255 || asteroids.length > 255 || pickups.length > 255) {
    throw new RangeError('Забагато сутностей у знімку');
  }

  let size = 14;
  for (const player of players) size += stringSize(player.id) + stringSize(player.name) + 27;
  for (const bullet of bullets) size += stringSize(bullet.id) + stringSize(bullet.ownerId) + 18;
  for (const asteroid of asteroids) size += stringSize(asteroid.id) + 21;
  for (const pickup of pickups) size += stringSize(pickup.id) + 12;

  const buffer = new ArrayBuffer(size);
  const view = new DataView(buffer);
  view.setUint8(0, PROTOCOL_VERSION);
  view.setUint8(1, MESSAGE_SNAPSHOT);
  view.setUint32(2, snapshot.tick, true);
  view.setUint32(6, snapshot.seed, true);
  view.setUint8(10, players.length);
  view.setUint8(11, bullets.length);
  view.setUint8(12, asteroids.length);
  view.setUint8(13, pickups.length);
  let offset = 14;

  for (const player of players) {
    offset = writeString(view, offset, player.id);
    offset = writeString(view, offset, player.name);
    assertFinite(player.x, 'player.x');
    assertFinite(player.y, 'player.y');
    assertFinite(player.vx, 'player.vx');
    assertFinite(player.vy, 'player.vy');
    view.setFloat32(offset, player.x, true);
    view.setFloat32(offset + 4, player.y, true);
    view.setFloat32(offset + 8, player.vx, true);
    view.setFloat32(offset + 12, player.vy, true);
    view.setInt16(offset + 16, Math.round(player.angle * 10000), true);
    view.setUint8(offset + 18, player.hp);
    view.setUint32(offset + 19, player.ackSeq, true);
    view.setUint16(offset + 23, player.respawnTicks, true);
    view.setUint16(offset + 25, player.score, true);
    offset += 27;
  }

  for (const bullet of bullets) {
    offset = writeString(view, offset, bullet.id);
    offset = writeString(view, offset, bullet.ownerId);
    assertFinite(bullet.x, 'bullet.x');
    assertFinite(bullet.y, 'bullet.y');
    assertFinite(bullet.vx, 'bullet.vx');
    assertFinite(bullet.vy, 'bullet.vy');
    view.setFloat32(offset, bullet.x, true);
    view.setFloat32(offset + 4, bullet.y, true);
    view.setFloat32(offset + 8, bullet.vx, true);
    view.setFloat32(offset + 12, bullet.vy, true);
    view.setUint16(offset + 16, Math.max(0, Math.round(bullet.ttl * 1000)), true);
    offset += 18;
  }

  for (const asteroid of asteroids) {
    offset = writeString(view, offset, asteroid.id);
    view.setUint8(offset, asteroid.homing ? 1 : 0);
    assertFinite(asteroid.x, 'asteroid.x');
    assertFinite(asteroid.y, 'asteroid.y');
    assertFinite(asteroid.vx, 'asteroid.vx');
    assertFinite(asteroid.vy, 'asteroid.vy');
    assertFinite(asteroid.radius, 'asteroid.radius');
    view.setFloat32(offset + 1, asteroid.x, true);
    view.setFloat32(offset + 5, asteroid.y, true);
    view.setFloat32(offset + 9, asteroid.vx, true);
    view.setFloat32(offset + 13, asteroid.vy, true);
    view.setFloat32(offset + 17, asteroid.radius, true);
    offset += 21;
  }

  for (const pickup of pickups) {
    offset = writeString(view, offset, pickup.id);
    assertFinite(pickup.x, 'pickup.x');
    assertFinite(pickup.y, 'pickup.y');
    assertFinite(pickup.radius, 'pickup.radius');
    view.setFloat32(offset, pickup.x, true);
    view.setFloat32(offset + 4, pickup.y, true);
    view.setFloat32(offset + 8, pickup.radius, true);
    offset += 12;
  }

  return buffer;
}

const snapshotTextDecoder = new TextDecoder(); // Переиспользуємо стандартний декодер між мережевими знімками.

function readStringLength(view: DataView, offset: number): number {
  if (offset >= view.byteLength) throw new RangeError('Пошкоджений рядок у знімку');
  return view.getUint8(offset);
}

function readString(view: DataView, offset: number): string {
  const length = readStringLength(view, offset);
  const start = offset + 1;
  const end = start + length;
  if (end > view.byteLength) throw new RangeError('Обрізаний рядок у знімку');
  return snapshotTextDecoder.decode(new Uint8Array(view.buffer, view.byteOffset + start, length));
}

function readFiniteFloat(view: DataView, offset: number): number {
  const value = view.getFloat32(offset, true);
  if (!Number.isFinite(value)) throw new RangeError('У знімку є нескінченне або NaN-число');
  return value;
}

// Декодер перевіряє довжину і діапазон кожного поля перед його використанням.
export function deserializeSnapshot(data: unknown): Snapshot {
  const view = asDataView(data);
  if (view.byteLength < 14) throw new RangeError('Знімок надто короткий');
  if (view.getUint8(0) !== PROTOCOL_VERSION || view.getUint8(1) !== MESSAGE_SNAPSHOT) {
    throw new Error('Непідтримувана версія або тип знімка');
  }

  const tick = asTick(view.getUint32(2, true));
  const seed = view.getUint32(6, true);
  const playerCount = view.getUint8(10);
  const bulletCount = view.getUint8(11);
  const asteroidCount = view.getUint8(12);
  const pickupCount = view.getUint8(13);
  const players: ShipEntity[] = [];
  const bullets: BulletEntity[] = [];
  const asteroids: AsteroidEntity[] = [];
  const pickups: PickupEntity[] = [];
  let offset = 14;

  for (let index = 0; index < playerCount; index += 1) {
    const idLength = readStringLength(view, offset);
    const id = readString(view, offset);
    offset += idLength + 1;
    const nameLength = readStringLength(view, offset);
    const name = readString(view, offset);
    offset += nameLength + 1;
    if (offset + 27 > view.byteLength) throw new RangeError('Обрізаний стан корабля');
    players.push({
      kind: 'ship',
      id: asEntityId(id),
      name,
      x: readFiniteFloat(view, offset),
      y: readFiniteFloat(view, offset + 4),
      vx: readFiniteFloat(view, offset + 8),
      vy: readFiniteFloat(view, offset + 12),
      angle: view.getInt16(offset + 16, true) / 10000,
      hp: view.getUint8(offset + 18),
      ackSeq: asSeq(view.getUint32(offset + 19, true)),
      respawnTicks: view.getUint16(offset + 23, true),
      score: view.getUint16(offset + 25, true),
    });
    offset += 27;
  }

  for (let index = 0; index < bulletCount; index += 1) {
    const idLength = readStringLength(view, offset);
    const id = readString(view, offset);
    offset += idLength + 1;
    const ownerIdLength = readStringLength(view, offset);
    const ownerId = readString(view, offset);
    offset += ownerIdLength + 1;
    if (offset + 18 > view.byteLength) throw new RangeError('Обрізаний стан кулі');
    bullets.push({
      kind: 'bullet',
      id: asEntityId(id),
      ownerId: asEntityId(ownerId),
      x: readFiniteFloat(view, offset),
      y: readFiniteFloat(view, offset + 4),
      vx: readFiniteFloat(view, offset + 8),
      vy: readFiniteFloat(view, offset + 12),
      ttl: view.getUint16(offset + 16, true) / 1000,
    });
    offset += 18;
  }

  for (let index = 0; index < asteroidCount; index += 1) {
    const idLength = readStringLength(view, offset);
    const id = readString(view, offset);
    offset += idLength + 1;
    if (offset + 21 > view.byteLength) throw new RangeError('Обрізаний стан астероїда');
    const flags = view.getUint8(offset);
    if ((flags & 0xfe) !== 0) throw new RangeError('Астероїд містить невідомі прапорці');
    asteroids.push({
      kind: 'asteroid',
      id: asEntityId(id),
      homing: Boolean(flags & 1),
      x: readFiniteFloat(view, offset + 1),
      y: readFiniteFloat(view, offset + 5),
      vx: readFiniteFloat(view, offset + 9),
      vy: readFiniteFloat(view, offset + 13),
      radius: readFiniteFloat(view, offset + 17),
    });
    offset += 21;
  }

  for (let index = 0; index < pickupCount; index += 1) {
    const idLength = readStringLength(view, offset);
    const id = readString(view, offset);
    offset += idLength + 1;
    if (offset + 12 > view.byteLength) throw new RangeError('Обрізаний стан pickup');
    pickups.push({
      kind: 'pickup',
      id: asEntityId(id),
      x: readFiniteFloat(view, offset),
      y: readFiniteFloat(view, offset + 4),
      radius: readFiniteFloat(view, offset + 8),
    });
    offset += 12;
  }

  if (offset !== view.byteLength) throw new RangeError('У знімку є зайві байти');
  return { v: PROTOCOL_VERSION, type: 'snapshot', tick, seed, players, bullets, asteroids, pickups };
}

// Один контракт дає обрати JSON чи двійкове кодування, не змінюючи модель Snapshot.
export interface SnapshotCodec<Encoded> {
  readonly format: 'json' | 'binary';
  encode(snapshot: Snapshot): Encoded;
  decode(encoded: unknown): Snapshot;
}

export const binaryCodec: SnapshotCodec<ArrayBuffer> = {
  format: 'binary',
  encode: serializeSnapshot,
  decode: deserializeSnapshot,
};

export const jsonCodec: SnapshotCodec<string> = {
  format: 'json',
  encode: (snapshot) => JSON.stringify(snapshot),
  decode: (encoded) => {
    const result = parseServerMessage(typeof encoded === 'string' ? JSON.parse(encoded) : encoded);
    if (!result.ok) throw new TypeError(result.reason);
    switch (result.message.type) {
      case 'snapshot':
        return result.message;
      case 'joined_success':
      case 'roster':
      case 'chat':
      case 'pong':
        throw new TypeError('Очікувався знімок світу');
      default: {
        const exhaustive: never = result.message;
        return exhaustive;
      }
    }
  },
};

// Повертаємо координати сутності; switch перевіряє, що кожен kind має гілку.
export function entityPosition(entity: ShipEntity | BulletEntity | AsteroidEntity | PickupEntity): {
  readonly x: number;
  readonly y: number;
} {
  switch (entity.kind) {
    case 'ship':
    case 'bullet':
    case 'asteroid':
    case 'pickup':
      return { x: entity.x, y: entity.y };
    default: {
      const exhaustive: never = entity;
      return exhaustive;
    }
  }
}
