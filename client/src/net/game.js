// Клієнтський мережевий світ передбачає власний рух і згладжує решту гравців.
import {
  ARENA_HEIGHT,
  ARENA_WIDTH,
  FIXED_DT,
  createShipState,
  createBullet,
  integrate,
  integrateBullet,
  interpolateAngle,
  wrapCoordinate,
  wrappedDelta,
} from '../../../shared/engine.js';
import { NetGraph } from '../netgraph.js';
import { sprites, drawSprite } from '../sprites.js'; // Використовуємо ті самі спрайтшити, що й локальна гра.
import { emit } from '../events.js'; // Повідомляємо наявну звукову шину та HUD про мережеві події.

// Порівнюємо послідовності з урахуванням переповнення uint32.
function isAcknowledged(sequence, ackSeq) {
  return (ackSeq - sequence) >>> 0 < 0x80000000;
}

// Залишаємо в клієнтському стані лише поля, які сервер реально передає.
function copyShipState(player) {
  return {
    x: player.x,
    y: player.y,
    vx: player.vx,
    vy: player.vy,
    angle: player.angle,
    hp: player.hp,
    score: player.score,
    respawnTicks: player.respawnTicks,
    ackSeq: player.ackSeq,
  };
}

// Один NetworkGame відповідає за передбачення, звірку та мережеве малювання.
export class NetworkGame {
  constructor({ prediction = true, onInput = () => {} } = {}) {
    this.prediction = prediction;
    this.onInput = onInput;
    this.graph = new NetGraph();
    this.playerId = null;
    this.localState = null;
    this.inputHistory = [];
    this.nextSeq = 0;
    this.accumulator = 0;
    this.fireQueued = false;
    this.predictedBullets = new Map();
    this.snapshotHistory = [];
    this.renderWidth = 1280;
    this.renderHeight = 720;
    this.correctionX = 0;
    this.correctionY = 0;
    this.correctionAngle = 0;
    this.lastAuthoritativeState = null;
    this.lastAsteroids = new Map();
    this.effects = [];
    this.thrusting = false;
    this.renderInput = { gas: false, turn: 0 };
  }

  // З'єднання задається після створення сесії, коли стала відома її sendInput-функція.
  setInputSender(sendInput) {
    this.onInput = sendInput;
  }

  // Запам'ятовуємо розмір вікна, щоб масштабувати фіксовану арену.
  setViewport(width, height) {
    this.renderWidth = width;
    this.renderHeight = height;
  }

  // Починаємо локальний стан із серверного привітання, а не з даних браузера.
  initialize(welcome) {
    this.playerId = welcome.playerId;
    this.nextSeq = welcome.state?.ackSeq ?? 0;
    this.localState = welcome.state ? copyShipState(welcome.state) : createShipState(ARENA_WIDTH / 2, ARENA_HEIGHT / 2); // Показуємо власний корабель, навіть якщо старий сервер ще не надіслав стартовий стан.
    this.inputHistory.length = 0;
    this.snapshotHistory.length = 0;
    this.predictedBullets.clear();
    this.correctionX = 0;
    this.correctionY = 0;
    this.correctionAngle = 0;
    this.accumulator = 0;
    this.lastAuthoritativeState = copyShipState(this.localState);
    this.lastAsteroids.clear();
    this.effects.length = 0;
    this.thrusting = false;
    emit('shipSpawned', { hp: this.localState.hp }); // Оновлюємо життя в тому самому HUD, що й до мережевого режиму.
    if (welcome.snapshot) this.receiveSnapshot(welcome.snapshot); // Початковий знімок одразу показує астероїди й інших пілотів.
  }

  // Запам'ятовуємо натискання пробілу до наступного мережевого кроку.
  queueFire() {
    this.fireQueued = true;
  }

  // Накопичуємо 60-герцові кадри й надсилаємо рівно один input на 30-герцовий крок.
  update(frameDt, controls) {
    if (!this.playerId || !this.localState) return;
    this.accumulator += frameDt;
    this.thrusting = Boolean(controls.gas); // Вогонь двигуна відповідає натисканню газу в мережевому режимі.
    this.renderInput = { gas: Boolean(controls.gas), turn: controls.turn };
    this.correctionX *= Math.exp(-frameDt / 0.1);
    this.correctionY *= Math.exp(-frameDt / 0.1);
    this.correctionAngle *= Math.exp(-frameDt / 0.1);
    this.#stepEffects(frameDt); // Локальні частинки згасають плавно між серверними знімками.

    while (this.accumulator >= FIXED_DT) {
      this.accumulator -= FIXED_DT;
      this.#stepInput(controls);
    }
    this.graph.pendingInputCount = this.inputHistory.length;
  }

  // Застосовуємо input передбаченням, додаємо його до черги й відправляємо серверу.
  #stepInput(controls) {
    this.nextSeq = (this.nextSeq + 1) >>> 0;
    const input = {
      seq: this.nextSeq,
      gas: Boolean(controls.gas),
      turn: controls.turn,
      shoot: this.fireQueued,
    };
    this.fireQueued = false;
    this.inputHistory.push(input);
    if (this.prediction) this.localState = integrate(this.localState, input, FIXED_DT);
    if (input.shoot) emit('fired', { x: this.localState.x, y: this.localState.y }); // Повторно використовуємо звук пострілу з лабораторної 4.

    for (const [id, bullet] of this.predictedBullets) {
      const nextBullet = integrateBullet(bullet, FIXED_DT);
      if (nextBullet.dead) this.predictedBullets.delete(id);
      else this.predictedBullets.set(id, nextBullet);
    }
    if (input.shoot && this.prediction) {
      const bullet = createBullet(this.localState, this.playerId, input.seq);
      this.predictedBullets.set(bullet.id, bullet);
    }

    this.onInput(input);
  }

  // RTT вимірюється від клієнтського ping до поверненої сервером мітки часу.
  receivePong(message) {
    if (Number.isFinite(message.sentAt)) {
      this.graph.setRtt(Math.max(0, performance.now() - message.sentAt));
    }
  }

  // Додаємо знімок до історії, звіряємо свій стан і повторюємо непідтверджені input.
  receiveSnapshot(snapshot) {
    if (!Array.isArray(snapshot.players) || !Array.isArray(snapshot.bullets)) return;
    const receivedAt = performance.now();
    const previousSnapshot = this.snapshotHistory.at(-1)?.snapshot;
    this.graph.snapshotReceived();
    this.snapshotHistory.push({ receivedAt, snapshot });
    while (this.snapshotHistory.length > 30) this.snapshotHistory.shift();

    const asteroidIds = new Set();
    for (const asteroid of snapshot.asteroids ?? []) asteroidIds.add(asteroid.id);
    let asteroidExploded = false;
    for (const [id, asteroid] of this.lastAsteroids) {
      if (asteroidIds.has(id)) continue;
      this.#spawnExplosion(asteroid.x, asteroid.y);
      asteroidExploded = true;
    }
    this.lastAsteroids = new Map((snapshot.asteroids ?? []).map((asteroid) => [asteroid.id, asteroid]));

    const serverPlayer = snapshot.players.find((player) => player.id === this.playerId);
    if (!serverPlayer) return;
    let remoteExploded = false;
    const previousPlayers = new Map((previousSnapshot?.players ?? []).map((player) => [player.id, player]));
    for (const player of snapshot.players) {
      const previousPlayer = previousPlayers.get(player.id);
      if (player.id === this.playerId || !previousPlayer || player.hp >= previousPlayer.hp) continue;
      emit('hit', { x: player.x, y: player.y, hp: player.hp, local: false }); // Звук є, але життя власника HUD не змінюються.
      if (player.hp === 0) {
        this.#spawnExplosion(player.x, player.y, 30);
        remoteExploded = true;
      }
    }
    const previousServerState = this.lastAuthoritativeState;
    let localExploded = false;
    if (previousServerState && serverPlayer.hp < previousServerState.hp) {
      emit('hit', { x: serverPlayer.x, y: serverPlayer.y, hp: serverPlayer.hp }); // Серверне влучання оновлює той самий HUD і звук.
      if (serverPlayer.hp === 0) {
        this.#spawnExplosion(serverPlayer.x, serverPlayer.y, 30);
        localExploded = true;
      }
    }
    if (previousServerState?.hp <= 0 && serverPlayer.hp > 0) {
      emit('shipSpawned', { hp: serverPlayer.hp }); // Після серверного респауну життя знову видно в HUD.
    } else if (previousServerState && serverPlayer.hp > previousServerState.hp) {
      emit('healed', { hp: serverPlayer.hp }); // Сервер підтверджує підбір аптечки й оновлює HUD.
    }
    const scoreChanged = previousServerState && serverPlayer.score !== previousServerState.score;
    if (asteroidExploded || remoteExploded || localExploded || scoreChanged) {
      emit('exploded', { score: serverPlayer.score }); // Оновлюємо рахунок і звук після підтвердженого сервером вибуху.
    }
    this.lastAuthoritativeState = copyShipState(serverPlayer);
    const previousPrediction = this.localState;
    const acknowledged = serverPlayer.ackSeq >>> 0;
    this.inputHistory = this.inputHistory.filter((input) => !isAcknowledged(input.seq, acknowledged));
    let correctedState = copyShipState(serverPlayer);
    if (this.prediction) {
      for (const input of this.inputHistory) correctedState = integrate(correctedState, input, FIXED_DT);
    }

    if (previousPrediction && this.prediction) {
      const previousVisualX = wrapCoordinate(previousPrediction.x + this.correctionX, ARENA_WIDTH);
      const previousVisualY = wrapCoordinate(previousPrediction.y + this.correctionY, ARENA_HEIGHT);
      const previousVisualAngle = previousPrediction.angle + this.correctionAngle;
      this.correctionX = wrappedDelta(correctedState.x, previousVisualX, ARENA_WIDTH);
      this.correctionY = wrappedDelta(correctedState.y, previousVisualY, ARENA_HEIGHT);
      this.correctionAngle = Math.atan2(
        Math.sin(previousVisualAngle - correctedState.angle),
        Math.cos(previousVisualAngle - correctedState.angle),
      );
      this.graph.reconError = Math.hypot(this.correctionX, this.correctionY);
    } else {
      this.correctionX = 0;
      this.correctionY = 0;
      this.correctionAngle = 0;
      this.graph.reconError = previousPrediction
        ? Math.hypot(
            wrappedDelta(correctedState.x, previousPrediction.x, ARENA_WIDTH),
            wrappedDelta(correctedState.y, previousPrediction.y, ARENA_HEIGHT),
          )
        : 0;
    }
    this.localState = correctedState;

    const authoritativeBulletIds = new Set(snapshot.bullets.map((bullet) => bullet.id));
    for (const [id, bullet] of this.predictedBullets) {
      if (authoritativeBulletIds.has(id) || isAcknowledged(bullet.seq, acknowledged)) {
        this.predictedBullets.delete(id);
      }
    }
    this.graph.pendingInputCount = this.inputHistory.length;
  }

  // Малюємо серверний світ, свій прогноз і панель мережевих показників.
  render(ctx) {
    ctx.clearRect(0, 0, this.renderWidth, this.renderHeight);
    ctx.fillStyle = '#0b0c10';
    ctx.fillRect(0, 0, this.renderWidth, this.renderHeight);
    ctx.save();
    ctx.scale(this.renderWidth / ARENA_WIDTH, this.renderHeight / ARENA_HEIGHT);
    this.#drawArena(ctx);
    this.#drawAsteroids(ctx);
    this.#drawPickups(ctx);
    this.#drawEffects(ctx);
    this.#drawRemoteShips(ctx);
    this.#drawServerBullets(ctx);
    this.#drawPredictedShip(ctx);
    this.#drawPredictedBullets(ctx);
    ctx.restore();
    this.graph.draw(ctx);
  }

  // Малюємо статичні зірки, щоб арена мала впізнаваний фон.
  #drawArena(ctx) {
    ctx.fillStyle = 'rgba(255,255,255,0.28)';
    for (let index = 0; index < 90; index += 1) {
      ctx.fillRect((index * 137) % ARENA_WIDTH, (index * 83) % ARENA_HEIGHT, 2, 2);
    }
  }

  // Малюємо астероїди з серверного знімка, а не створюємо окремі локальні камені.
  #drawAsteroids(ctx) {
    const pair = this.#interpolationPair();
    if (!pair) return;
    const nextAsteroids = new Map(pair.second.snapshot.asteroids?.map((asteroid) => [asteroid.id, asteroid]) ?? []);
    for (const previous of pair.first.snapshot.asteroids ?? []) {
      const next = nextAsteroids.get(previous.id) ?? previous;
      const asteroid = {
        ...previous,
        x: previous.x + (next.x - previous.x) * pair.alpha,
        y: previous.y + (next.y - previous.y) * pair.alpha,
      };
      const image = sprites.asteroid;
      if (image) {
        drawSprite(ctx, image, asteroid.x, asteroid.y, asteroid.radius * 2.4, asteroid.radius * 2.4, 0, {
          x: 0,
          y: 0,
          w: image.width,
          h: image.height,
        }); // Малюємо завантажену текстуру астероїда, як у локальному World.
      } else {
        ctx.beginPath();
        ctx.arc(asteroid.x, asteroid.y, asteroid.radius, 0, Math.PI * 2);
        ctx.strokeStyle = '#aaa';
        ctx.stroke();
      } // Запасне коло видно лише тоді, коли файл спрайта недоступний.
      if (asteroid.homing) {
        ctx.beginPath();
        ctx.arc(asteroid.x, asteroid.y, asteroid.radius + 4, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(255, 140, 66, 0.65)';
        ctx.lineWidth = 2;
        ctx.stroke();
      } // Помаранчева обводка показує самонавідну перешкоду.
    }
  }

  // Малюємо аптечки тим самим зеленим знаком, що й локальна гра.
  #drawPickups(ctx) {
    const pickups = this.snapshotHistory.at(-1)?.snapshot.pickups ?? [];
    for (const pickup of pickups) {
      ctx.fillStyle = '#4ade80';
      ctx.fillRect(pickup.x - 5, pickup.y - 5, 10, 10);
      ctx.fillStyle = '#0b0c10';
      ctx.font = 'bold 10px monospace';
      ctx.textAlign = 'center';
      ctx.fillText('+', pickup.x, pickup.y + 4);
    }
  }

  // Беремо стан інших кораблів за 100 мілісекунд до поточного часу й інтерполюємо його.
  #drawRemoteShips(ctx) {
    const pair = this.#interpolationPair();
    if (!pair) return;
    const firstPlayers = new Map(pair.first.snapshot.players.map((player) => [player.id, player]));
    const secondPlayers = new Map(pair.second.snapshot.players.map((player) => [player.id, player]));
    for (const [id, second] of secondPlayers) {
      if (id === this.playerId || second.hp <= 0) continue;
      const previous = firstPlayers.get(id);
      const first = !previous || previous.hp <= 0 ? second : previous;
      const x = wrapCoordinate(first.x + wrappedDelta(first.x, second.x, ARENA_WIDTH) * pair.alpha, ARENA_WIDTH);
      const y = wrapCoordinate(first.y + wrappedDelta(first.y, second.y, ARENA_HEIGHT) * pair.alpha, ARENA_HEIGHT);
      const angle = interpolateAngle(first.angle, second.angle, pair.alpha);
      this.#drawShip(ctx, x, y, angle, second.name, second.hp, Math.hypot(second.vx, second.vy) > 10);
    }
  }

  // Знаходимо два знімки, між якими лежить обраний час рендеру.
  #interpolationPair() {
    const history = this.snapshotHistory;
    if (history.length === 0) return null;
    const targetTime = performance.now() - 50;
    let first = history[0];
    let second = history[history.length - 1];
    for (let index = 1; index < history.length; index += 1) {
      if (history[index].receivedAt >= targetTime) {
        first = history[index - 1];
        second = history[index];
        break;
      }
      first = history[index];
    }
    const duration = second.receivedAt - first.receivedAt;
    const alpha = duration > 0 ? Math.max(0, Math.min(1, (targetTime - first.receivedAt) / duration)) : 1;
    return { first, second, alpha };
  }

  // Малюємо останній серверний набір куль, який уже прийшов у кімнату.
  #drawServerBullets(ctx) {
    const latest = this.snapshotHistory.at(-1)?.snapshot;
    if (!latest) return;
    const localIds = new Set(this.predictedBullets.keys());
    for (const bullet of latest.bullets) {
      if (localIds.has(bullet.id)) continue;
      const visualBullet =
        bullet.ownerId === this.playerId
          ? {
              ...bullet,
              x: wrapCoordinate(bullet.x + this.correctionX, ARENA_WIDTH),
              y: wrapCoordinate(bullet.y + this.correctionY, ARENA_HEIGHT),
            }
          : bullet;
      this.#drawBullet(ctx, visualBullet); // Власна підтверджена куля згладжується разом із кораблем.
    }
  }

  // Малюємо власний корабель одразу після локального input.
  #drawPredictedShip(ctx) {
    if (!this.localState || !this.playerId || this.localState.hp <= 0) return;
    const visualState = integrate(this.localState, this.renderInput, this.accumulator);
    const x = wrapCoordinate(visualState.x + this.correctionX, ARENA_WIDTH);
    const y = wrapCoordinate(visualState.y + this.correctionY, ARENA_HEIGHT);
    const name =
      this.snapshotHistory.at(-1)?.snapshot.players.find((player) => player.id === this.playerId)?.name ?? 'Я';
    this.#drawShip(ctx, x, y, visualState.angle + this.correctionAngle, name, this.localState.hp, this.thrusting);
  }

  // Показуємо власні кулі ще до відповіді сервера.
  #drawPredictedBullets(ctx) {
    for (const bullet of this.predictedBullets.values()) {
      const visualBullet = integrateBullet(bullet, this.accumulator);
      if (visualBullet.dead) continue;
      this.#drawBullet(ctx, {
        ...visualBullet,
        x: wrapCoordinate(visualBullet.x + this.correctionX, ARENA_WIDTH),
        y: wrapCoordinate(visualBullet.y + this.correctionY, ARENA_HEIGHT),
      }); // Прогнозована куля лишається біля візуально скоригованого корабля.
    }
  }

  // Корабель малюється простим трикутником, повернутим носом за кутом фізики.
  #drawShip(ctx, x, y, angle, name, hp, thrusting = false) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle + Math.PI / 2); // Спрайт корабля в asset-файлі спрямований угору.
    const image = sprites.hero;
    if (image) {
      drawSprite(ctx, image, 0, 0, 45, 45, 0, { x: 0, y: 0, w: image.width, h: image.height });
    } else {
      ctx.beginPath();
      ctx.moveTo(20, 0);
      ctx.lineTo(-15, -13);
      ctx.lineTo(-10, 0);
      ctx.lineTo(-15, 13);
      ctx.closePath();
      ctx.strokeStyle = '#66fcf1';
      ctx.stroke();
    } // Повертаємо той самий запасний корабель, якщо спрайт відсутній.
    if (thrusting) {
      ctx.beginPath();
      ctx.moveTo(-15, -4);
      ctx.lineTo(-27, 0);
      ctx.lineTo(-15, 4);
      ctx.strokeStyle = '#ff8c42';
      ctx.stroke();
    } // Полум'я показує тягу власного та інших кораблів.
    ctx.restore();
    ctx.fillStyle = '#ffffff';
    ctx.font = '13px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(name + ' · HP ' + hp, x, y + 30);
  }

  // Куля має той самий колір і масштаб незалежно від протоколу.
  #drawBullet(ctx, bullet) {
    const image = sprites.bullets;
    if (image) {
      const frame = Math.floor((1.2 - bullet.ttl) * 12) % 4;
      const angle = Math.atan2(bullet.vy, bullet.vx);
      drawSprite(ctx, image, bullet.x, bullet.y, 16, 16, angle, { x: frame * 32, y: 0, w: 32, h: 32 });
    } else {
      ctx.beginPath();
      ctx.arc(bullet.x, bullet.y, 4, 0, Math.PI * 2);
      ctx.fillStyle = '#ffe66d';
      ctx.fill();
    } // Відновлюємо текстуровану кулю та лишаємо видимий запасний варіант.
  }

  // Додаємо локальні частинки у відповідь на підтверджене сервером знищення.
  #spawnExplosion(x, y, count = 15) {
    for (let index = 0; index < count; index += 1) {
      const angle = (index / count) * Math.PI * 2;
      const speed = 35 + ((index * 29) % 70);
      this.effects.push({
        x,
        y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        ttl: 0.55,
      });
    }
  }

  // Рухаємо й прибираємо декоративні частинки без впливу на серверну симуляцію.
  #stepEffects(dt) {
    this.effects = this.effects
      .map((effect) => ({
        ...effect,
        x: wrapCoordinate(effect.x + effect.vx * dt, ARENA_WIDTH),
        y: wrapCoordinate(effect.y + effect.vy * dt, ARENA_HEIGHT),
        ttl: effect.ttl - dt,
      }))
      .filter((effect) => effect.ttl > 0);
  }

  // Малюємо частинки вибухів поверх текстурованих сутностей.
  #drawEffects(ctx) {
    for (const effect of this.effects) {
      ctx.globalAlpha = Math.min(1, effect.ttl / 0.55);
      ctx.fillStyle = '#ff8c42';
      ctx.fillRect(effect.x, effect.y, 3, 3);
    }
    ctx.globalAlpha = 1;
  }
}
