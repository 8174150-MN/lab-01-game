// Переконуємося, що затриманий сервер не накопичує однакові команди руху.
import test from 'node:test'; // Запускаємо невеликий тест вбудованим Node runner.
import assert from 'node:assert/strict'; // Порівнюємо чергу вводу точними значеннями.
import { mkdir } from 'node:fs/promises'; // Створюємо каталог журналу перед створенням кімнати.
import { config } from '../src/config.js'; // Беремо перевірену директорію журналу.
import { RoomManager } from '../src/rooms.js'; // Тестуємо справжню серверну чергу.
import { asSeq, type InputCommand } from '@dogfight/shared/types'; // Створюємо branded послідовності input.

// Формуємо звичайну керувальну команду з заданою послідовністю.
function input(seq: number, gas: boolean, turn: -1 | 0 | 1, shoot: boolean): InputCommand {
  return { seq: asSeq(seq), gas, turn, shoot }; // Сервер отримає ту саму форму, що надсилає клієнт.
} // Завершуємо фабрику тестового input.

test('coalesces repeated movement states but preserves every shot event', async () => {
  await mkdir(config.LOG_DIR, { recursive: true }); // Забезпечуємо каталог для журналу кімнати.
  const manager = new RoomManager(); // Створюємо кімнату з повною серверною логікою.
  const room = manager.getRoom('default_room'); // Беремо кімнату для тестового гравця.
  assert.ok(room); // Без початкової кімнати тест не може продовжитися.
  const socket = {
    readyState: 1,
    bufferedAmount: 0,
    send(_message: string, callback?: () => void) {
      callback?.();
    },
    close() {},
    terminate() {},
  }; // Підміняємо лише мінімальний WebSocket API, який використовує кімната.
  try {
    const player = await room.addClient(socket, 'Queue Test'); // Додаємо гравця з чистою чергою.
    assert.ok(player); // Підтверджуємо, що кімната прийняла тестове з'єднання.
    assert.equal(room.queueInput(socket, input(1, false, 0, false)), true); // Додаємо перший стан без руху й пострілу.
    assert.equal(room.queueInput(socket, input(2, false, 0, false)), true); // Надсилаємо той самий стан наступним кроком.
    assert.deepEqual(player.inputQueue, [input(2, false, 0, false)]); // Повтор замінює старий запис, але зберігає найновіший seq.
    assert.equal(room.queueInput(socket, input(3, false, 0, true)), true); // Додаємо одноразову подію пострілу.
    assert.equal(room.queueInput(socket, input(4, false, 0, false)), true); // Додаємо наступний стан після пострілу.
    assert.equal(room.queueInput(socket, input(5, false, 0, false)), true); // Згортаємо лише повтор стану після пострілу.
    assert.deepEqual(player.inputQueue, [
      input(2, false, 0, false),
      input(3, false, 0, true),
      input(5, false, 0, false),
    ]); // Shot лишився на своїй послідовності.
  } finally {
    await room.removeClient(socket); // Прибираємо гравця й закриваємо його кімнатний журнал.
    await manager.close(); // Гарантуємо завершення решти потоків тесту.
  } // Завершуємо тест без активних серверних ресурсів.
}); // Перевіряємо стиснення повторів без втрати пострілів.
