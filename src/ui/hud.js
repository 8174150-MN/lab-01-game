// hud.js: показує життя, рахунок і ім'я. Читає лише події шини,
// світ про цей модуль нічого не знає.
import { bus } from '../events.js';

// el це HTML-елемент <div id="hud">.
export function createHud(el) {
  // Усе, що показуємо, зберігаємо тут.
  const state = { name: '', hp: 3, score: 0, perf: '' };

  // Перемальовує текст HUD із поточного стану.
  function render() {
    el.innerText =
      `${state.name} | ${state.perf} | Життя: ${state.hp} | Рахунок: ${state.score}`;
  }

  // Вибух: у деталях події приходить поточний рахунок.
  bus.addEventListener('exploded', (e) => {
    // e.detail це об'єкт, який передали в emit(...).
    if (e.detail.score !== undefined) state.score = e.detail.score;
    render();
  });

  // Корабель отримав удар: у деталях лишилось життів.
  bus.addEventListener('hit', (e) => {
    state.hp = e.detail.hp;
    render();
  });

  // Корабель підібрав аптечку.
  bus.addEventListener('healed', (e) => {
    state.hp = e.detail.hp;
    render();
  });

  // З'явився новий корабель (старт або відродження): життя скидаються.
  bus.addEventListener('shipSpawned', (e) => {
    state.hp = e.detail.hp;
    render();
  });

  // Команди для main.js.
  return {
    setName(name) { state.name = name; render(); },
    // setPerf викликає ігровий цикл щокадру (текст про FPS).
    setPerf(text) { state.perf = text; render(); },
  };
}