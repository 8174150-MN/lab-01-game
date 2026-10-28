// Підключаємо файл, який відповідає за відстеження натискань клавіш на клавіатурі
import { createInput } from './input.js';

// Підключаємо файл ігрового циклу, який стабільно крутить кадри гри (FPS)
import { createLoop } from './loop.js';

// Підключаємо наш клас World (менеджер світу, який ми розібрали вище)
import { World } from './world.js';

// Підключаємо класи Ship (корабель) та Asteroid (астероїд) із файлу сутностей
import { Ship, Asteroid } from './entities.js';

// Підключаємо функцію композиції withHoming, яка перетворює звичайний астероїд на самонавідний
import { withHoming } from './components.js'; 

// Підключаємо наші функції завантаження з файлу loader.js (папка utils)
import { loadJson, loadAll, loadAllSequential } from './utils/loader.js';

import { initAudio } from './utils/audio.js';
import { sprites } from './sprites.js';
import { Lobby } from './lobby.js';
import { createLobbyView } from './ui/lobby.js';
import { createHud } from './ui/hud.js';
import { showError } from './ui/errorScreen.js';
// Знаходимо у нашому HTML-файлі (index.html) тег <canvas> з ігровим полем за його id
const canvas = document.getElementById('gameCanvas');

// Отримуємо з холста 2D-контекст (це наш «пензлик», яким ми будемо малювати фігури на екрані)
const ctx = canvas.getContext('2d');

// Знаходимо HTML-елемент HUD (текстове поле зверху екрана для виведення життів та рахунку)
const hud = document.getElementById('hud');

// Створюємо змінні для майбутніх розмірів ігрового вікна
let canvasWidth, canvasHeight;

// Функція, яка підлаштовує розмір ігрового поля під екран або зміну розміру вікна браузера
function resize() {
    // Визначаємо щільність пікселів екрана (важливо для чіткості графіки на сучасних екранах/Retina)
    const dpr = window.devicePixelRatio || 1;
    
    // Записуємо поточну ширину вікна браузера
    canvasWidth = window.innerWidth;
    
    // Записуємо поточну висоту вікна браузера
    canvasHeight = window.innerHeight;
    
    // Множимо фізичну ширину canvas на щільність пікселів, щоб гра не виглядала розмитою
    canvas.width = canvasWidth * dpr;
    
    // Множимо фізичну висоту canvas на щільність пікселів
    canvas.height = canvasHeight * dpr;
    
    // Задаємо CSS-стиль ширини, щоб холст розтягнувся на весь екран
    canvas.style.width = `${canvasWidth}px`;
    
    // Задаємо CSS-стиль висоти
    canvas.style.height = `${canvasHeight}px`;
    
    // Масштабуємо наш «пензлик» (ctx) відповідно до щільності пікселів екрана
    ctx.scale(dpr, dpr);
}

// Слухаємо подію: якщо користувач змінює розмір вікна браузера — автоматично викликаємо функцію resize
window.addEventListener('resize', resize);

// Викликаємо функцію resize одразу при старті програми, щоб налаштувати початковий розмір екрана
resize();

// Створюємо об'єкт для зчитування клавіатури
const input = createInput();

// Створюємо новий світ гри (World), передаючи йому ширину та висоту екрана
const world = new World(canvasWidth, canvasHeight);

// Створюємо новий корабель (Ship) у самій середині екрана (ділимо ширину і висоту навпіл)
let ship = new Ship(canvasWidth / 2, canvasHeight / 2);

// Додаємо створений корабель у наш світ, щоб він з'явився у грі
world.spawn(ship);
// playing: чи почалась гра. Поки гравець у лобі, пробіл не стріляє.
let playing = false;
// Ім'я гравця з лобі.

// ОБРОБКА СТРІЛЬБИ ТА ФІКС КОНТЕКСТУ THIS:
// Слухаємо натискання клавіш на клавіатурі (подія keydown)
window.addEventListener('keydown', (e) => {
    
    // Якщо натиснута клавіша "Пробіл" (код клавіші 'Space')
    if (e.code === 'Space' && playing) {
        // Викликаємо метод стрільби у нашого корабля, передаючи йому світ (world)
        // ВАЖЛИВО: Використання стрілочної функції `(e) => {}` рятує від проблеми з втратою `this`. 
        // Якби ми написали просто `window.addEventListener('keydown', ship.fire)`, то всередині методу `fire` 
        // слово `this` вказувало б на об'єкт вікна браузера (Window), а не на корабель, і гра випала б з помилкою.
        ship.fire(world);
    }
});

// Змінна-таймер для затримки перед відродженням (респауном) корабля після його смерті
let respawnTimer = 0;

// Головна функція логіки (update), яка оновлює гру на кожному кадрі за проміжок часу dt
function update(dt) {
    
    // Передаємо у світ час між кадрами (dt) та поточний стан клавіатури (input), 
    // щоб світ оновив рух усіх об'єктів та перевірив зіткнення
    world.step(dt, input.getState());

    // Якщо корабель гравця загинув (isDead стало true)
    if (ship.isDead) {
        
        // Якщо таймер ще не був запущений, встановлюємо затримку у 2 секунди
        if (respawnTimer === 0) {
            respawnTimer = 2;
        }
        
        // Зменшуємо значення таймера на час, що минув між кадрами (dt)
        respawnTimer -= dt;
        
        // Коли таймер добіг кінця (пройшло 2 секунди)
        if (respawnTimer <= 0) {
            
            // Створюємо новий корабель по центру екрана
            ship = new Ship(canvasWidth / 2, canvasHeight / 2);
            
            // Додаємо новий корабель у світ
            world.spawn(ship);
            
            // Скидаємо таймер назад до нуля для наступних смертей
            respawnTimer = 0;
        }
    }
    
    // Рандомний спавн астероїдів: з маленькою ймовірністю (менше 2% на кожному кадрі) створюємо новий астероїд
    if (Math.random() < 0.02) {
        
        // Створюємо астероїд зверху екрана у випадковій точці по горизонталі (Math.random() * canvasWidth)
        const asteroid = new Asteroid(Math.random() * canvasWidth, 0, 15);
        
        // ВИКОРИСТАННЯ КОМПОЗИЦІЇ: з 20% ймовірністю (0.2) та за умови, що корабель живий, 
        // перетворюємо цей астероїд на самонавідний (homing), який буде переслідувати корабель
        if (Math.random() < 0.2 && !ship.isDead) {
            world.spawn(withHoming(asteroid, ship, 50));
        } else {
            // В іншому випадку додаємо у світ звичайний астероїд
            world.spawn(asteroid);
        }
    }
}

// Функція малювання кадрів (draw), яка викликається ігровим циклом
function draw(alpha) {
    // Викликаємо метод рендеру у світу, який очищує екран і малює всі поточні сутності за допомогою пензлика (ctx)
    world.render(ctx);
}
// HUD: окремий модуль, що слухає події.
const hudView = createHud(hud);
// Запускаємо ігровий цикл (game loop), передаючи йому нашу логіку (update), малювання (draw) 
// та спеціальний об'єкт для оновлення верхньої панелі (HUD), де показуються життя (HP) та рахунок (Score)
const loop = createLoop(update, draw, {
    set innerText(text) {
        // Кожен кадр оновлюємо текст на екрані: показуємо стандартний текст циклу + живі HP + бали рахунку
        hudView.setPerf(text);
    }
});
// ЕКРАН ЗАВАНТАЖЕННЯ
// AudioContext потрібен, щоб розшифровувати звуки при завантаженні.
// Поки гравець не клацне, він "призупинений" (suspended), і браузер
// може показати попередження. Це нормально: у кроці зі звуком ми
// викличемо audioCtx.resume() після першого кліку.
const audioCtx = new AudioContext();

// Сюди покладемо завантажені ассети: assets.images.hero, assets.sounds.shoot...
let assets = null;

// Малює прогрес-бар на canvas. done з total файлів готово, label назва файлу.
function drawLoading(done, total, label) {
    // save/restore: запам'ятовуємо налаштування пензлика і повертаємо
    // назад, щоб не зіпсувати малювання гри.
    ctx.save();

    // Чорний фон на весь екран.
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvasWidth, canvasHeight);

    // Розміри й положення бару: 60% ширини, але не більше 400 пікселів.
    const barW = Math.min(400, canvasWidth * 0.6);
    const barH = 24;
    const x = (canvasWidth - barW) / 2;
    const y = canvasHeight / 2;

    // Рамка бару.
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.strokeRect(x, y, barW, barH);

    // Заповнена частина: ширина залежить від частки done/total.
    // total ? ... : 0 означає: якщо total не нуль, рахуй частку, інакше 0.
    ctx.fillStyle = '#0f0';
    ctx.fillRect(x, y, barW * (total ? done / total : 0), barH);

    // Напис над баром.
    ctx.fillStyle = '#fff';
    ctx.font = '16px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(`Завантаження ${done}/${total}  ${label}`, canvasWidth / 2, y - 16);

    ctx.restore();
}

// Перемикач
const MEASURE = false;
// describeError: перетворює технічну помилку на текст для гравця.
function describeError(error) {
    if (error.name === 'AbortError') return 'Завантаження скасовано.';
    if (error.name === 'TimeoutError') return 'Сервер не відповів вчасно (таймаут).';
    if (error.name === 'HttpError') return `Файл не знайдено або помилка сервера (HTTP ${error.status}).`;
    if (error.name === 'SyntaxError') return 'Файл пошкоджений (некоректний JSON).';
    return "Не вдалося завантажити ресурси (перевірте з'єднання).";
}

// applyFailure: тільки для галереї збоїв. Підміняє один ресурс на "поганий".
// structuredClone робить копію маніфесту, щоб не псувати оригінал.
function applyFailure(manifest, mode) {
    const m = structuredClone(manifest);
    // Зовнішній сервер, який завжди відповідає 404 (у Vite такий файл
    // повернув би index.html зі статусом 200, а не справжній 404).
    if (mode === '404') m.images.hero = 'https://httpbin.org/status/404';
    // Сервер відповідає через 10 с, а ми чекаємо лише 2 с (таймаут).
    if (mode === 'timeout') m.images.asteroid = 'https://httpbin.org/delay/10';
    // Файл існує, але JSON усередині зламаний.
    if (mode === 'json') m.json.arena = '/assets/broken.json';
    return m;
}

async function boot() {
    // Параметри адреси читаємо щоразу, бо після Retry вони змінюються.
    // ?fail=404|timeout|json|abort   ?delay=500   ?measure=1
    const params = new URLSearchParams(location.search);
    const failMode = params.get('fail');
    const delay = Number(params.get('delay')) || (failMode === 'abort' ? 800 : 0);

    // Один контролер на все завантаження: abort() зупиняє всі запити разом.
    const controller = new AbortController();

    try {
        drawLoading(0, 1, 'manifest');
        let manifest = await loadJson('/assets/manifest.json', controller.signal);
        manifest = applyFailure(manifest, failMode);

        // Режим abort: скасовуємо через 0.3 с, посеред завантаження.
        if (failMode === 'abort') setTimeout(() => controller.abort(), 300);

        const options = {
            audioCtx,
            signal: controller.signal,
            debugDelayMs: delay,
            timeoutMs: 2000,
            onProgress: (done, total, name) => drawLoading(done, total, name),
        };

        // Замір для README: відкрийте /?measure=1&delay=500
        if (params.has('measure')) {
            const t1 = performance.now();
            await loadAllSequential(manifest, options);
            const sequentialMs = performance.now() - t1;

            const t2 = performance.now();
            await loadAll(manifest, options);
            const concurrentMs = performance.now() - t2;

            console.log(`Послідовно: ${sequentialMs.toFixed(0)} мс`);
            console.log(`Одночасно: ${concurrentMs.toFixed(0)} мс`);
        }

        // Справжнє завантаження. Гра стартує лише після цього await.
        assets = await loadAll(manifest, options);
        console.log('Ассети готові:', assets);

        initAudio(audioCtx, assets.sounds);
        Object.assign(sprites, assets.images);
    

        // Стираємо екран завантаження й показуємо лобі.
        ctx.clearRect(0, 0, canvasWidth, canvasHeight);
        const lobby = new Lobby();
        const lobbyView = createLobbyView(lobby, document.getElementById('lobby'));

        lobby.addEventListener('joined', (e) => {
            const { name, arena } = e.detail;
            hudView.setName(name);
            audioCtx.resume();
            for (let i = 0; i < arena.asteroidCount; i++) {
                world.spawn(new Asteroid(Math.random() * canvasWidth, Math.random() * canvasHeight * 0.5, 15));
            }
            playing = true;
            loop.start();
        });

        lobbyView.show();
    } catch (error) {
        // Гра не падає: зупиняємо недовантажене й показуємо Retry.
        controller.abort();
        ctx.clearRect(0, 0, canvasWidth, canvasHeight);
        console.error('Збій завантаження:', error);

        showError(document.getElementById('errorScreen'), describeError(error), () => {
            // Retry: прибираємо ?fail з адреси й запускаємо завантаження знову.
            history.replaceState(null, '', location.pathname);
            boot();
        });
    }
}

boot();
