// hud.js: показує життя, рахунок і ім'я. Читає лише події шини,
// світ про цей модуль нічого не знає.
import { on } from '../events.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isHpDetail(value: unknown): value is { hp: number } {
  return isRecord(value) && typeof value.hp === 'number';
}

function isHitDetail(value: unknown): value is { hp: number; local?: boolean } {
  return (
    isRecord(value) && typeof value.hp === 'number' && (value.local === undefined || typeof value.local === 'boolean')
  );
}

function isScoreDetail(value: unknown): value is { score?: number } {
  return isRecord(value) && (value.score === undefined || typeof value.score === 'number');
}

// el це HTML-елемент <div id="hud">.
export function createHud(el: HTMLElement | null) {
  if (!el) throw new Error('HUD element was not found');
  const element = el;
  // Усе, що показуємо, зберігаємо тут.
  const state = { name: '', hp: 3, score: 0, perf: '' };

  // Перемальовує текст HUD із поточного стану.
  function render() {
    element.innerText = `${state.name} | ${state.perf} | Життя: ${state.hp} | Рахунок: ${state.score}`;
  }

  // Вибух: у деталях події приходить поточний рахунок.
  on('exploded', isScoreDetail, (detail) => {
    // e.detail це об'єкт, який передали в emit(...).
    if (detail.score !== undefined) state.score = detail.score;
    render();
  });

  // Корабель отримав удар: у деталях лишилось життів.
  on('hit', isHitDetail, (detail) => {
    if (detail.local !== false) state.hp = detail.hp;
    render();
  });

  // Корабель підібрав аптечку.
  on('healed', isHpDetail, (detail) => {
    state.hp = detail.hp;
    render();
  });

  // З'явився новий корабель (старт або відродження): життя скидаються.
  on('shipSpawned', isHpDetail, (detail) => {
    state.hp = detail.hp;
    render();
  });

  // Команди для main.js.
  return {
    setName(name: string) {
      state.name = name;
      render();
    },
    // setPerf викликає ігровий цикл щокадру (текст про FPS).
    setPerf(text: string) {
      state.perf = text;
      render();
    },
    // Мережева лабораторна встановлює авторитетні життя й рахунок із сервера.
    setGameState({ hp, score }: { readonly hp?: number; readonly score?: number } = {}) {
      if (typeof hp === 'number' && Number.isFinite(hp)) state.hp = hp;
      if (typeof score === 'number' && Number.isFinite(score)) state.score = score;
      render();
    },
  };
}
