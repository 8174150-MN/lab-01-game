import { expect, it } from 'vitest'; // Перевіряємо клієнтську звірку з серверним станом.
import { FIXED_DT } from '@dogfight/shared/engine'; // Один input відповідає фіксованому мережевому кроку.
import { asEntityId, asSeq, asTick } from '@dogfight/shared/types'; // Брендуємо ID, номер кроку й підтверджену команду.
import { parseServerMessage } from '@dogfight/shared/protocol'; // Створюємо welcome через ту саму runtime-схему.
import { NetworkGame } from '../src/net/game.js'; // Тестуємо справжній клієнт прогнозування.
import type { InputCommand } from '@dogfight/shared/types'; // Зберігаємо відправлені команди з коректним типом.
import type { Snapshot } from '@dogfight/shared/types'; // Перевіряємо серверні кадри типом спільного протоколу.

it('replays unacknowledged input after a server snapshot and drops acknowledged input', () => {
  const playerId = asEntityId('player-1'); // Фіксуємо ID клієнта для тестової кімнати.
  const player = {
    kind: 'ship' as const,
    id: playerId,
    name: 'Pilot',
    x: 500,
    y: 300,
    vx: 0,
    vy: 0,
    angle: 0,
    hp: 3,
    ackSeq: asSeq(0),
    respawnTicks: 0,
    score: 0,
  }; // Серверний корабель починає з нерухомого стану.
  const initialSnapshot: Snapshot = {
    v: 3,
    type: 'snapshot',
    tick: asTick(0),
    seed: 1,
    players: [player],
    bullets: [],
    asteroids: [],
    pickups: [],
  }; // Формуємо перший серверний кадр.
  const parsedWelcome = parseServerMessage({
    v: 1,
    type: 'joined_success',
    roomId: 'room-1',
    playerId,
    format: 'binary',
    seed: 1,
    tickRate: 30,
    arena: { width: 1280, height: 720 },
    state: player,
    snapshot: initialSnapshot,
    players: [{ id: playerId, name: 'Pilot' }],
  }); // Перевіряємо welcome так само, як перевіряє його справжній сокет.
  if (!parsedWelcome.ok || parsedWelcome.message.type !== 'joined_success')
    throw new Error('Welcome fixture must be valid'); // Не продовжуємо з невалідними тестовими даними.
  const sent: InputCommand[] = []; // Записуємо команди, які клієнт передає серверу.
  const game = new NetworkGame({ onInput: (input) => sent.push(input) }); // Створюємо клієнт із контрольованим транспортом.
  game.initialize(parsedWelcome.message); // Починаємо з авторитетного стану сервера.
  game.update(FIXED_DT, { gas: true, turn: 0 }); // Робимо один передбачений крок, поки сервер ще не підтвердив input.
  const predicted = game.localState; // Зберігаємо локальний стан після передбачення.
  expect(sent).toHaveLength(1); // Транспорт отримав одну команду з фіксованим кроком.
  expect(game.inputHistory).toHaveLength(1); // Команда лишається в черзі до підтвердження.
  expect(predicted?.x).toBeGreaterThan(player.x); // Передбачення одразу рухає корабель уперед.
  const unacknowledgedSnapshot = {
    ...initialSnapshot,
    tick: asTick(1),
    players: [{ ...player, ackSeq: asSeq(0) }],
  }; // Сервер повертає стан до отримання input.
  game.receiveSnapshot(unacknowledgedSnapshot); // Клієнт знову програє команду, якої ще немає в ackSeq.
  expect(game.inputHistory).toHaveLength(1); // Непідтверджена команда не губиться.
  expect(game.localState?.x).toBeCloseTo(predicted?.x ?? 0, 8); // Після replay локальне передбачення зберігає рух.
  const acknowledgedSnapshot = {
    ...initialSnapshot,
    tick: asTick(2),
    players: [{ ...player, ...predicted, ackSeq: asSeq(1) }],
  }; // Сервер підтверджує першу команду й її кінцевий стан.
  game.receiveSnapshot(acknowledgedSnapshot); // Звіряємо стан і прибираємо підтверджений input.
  expect(game.inputHistory).toHaveLength(0); // Ack очищає команду з черги replay.
  expect(game.localState?.ackSeq).toBe(asSeq(1)); // Клієнт зберіг останній номер, підтверджений сервером.
  expect(game.graph.pendingInputCount).toBe(0); // Netgraph показує порожню чергу.
  for (let tick = 3; tick < 15; tick += 1) {
    game.receiveSnapshot({ ...initialSnapshot, tick: asTick(tick) }); // Подаємо більше кадрів, ніж потрібно для інтерполяції.
  }
  expect(game.snapshotHistory).toHaveLength(8); // Історія не утримує старі об'єкти мережевих кадрів.
}); // Завершуємо перевірку reconciliation.
