import { createInput } from './input.js';
import { createLoop } from './loop.js';
import { World } from './world.js';
import { Ship, Asteroid } from './entities.js';
import { withHoming } from './components.js'; 
import { loadJson, loadAll, loadAllSequential } from './utils/loader.js';
import { initAudio } from './utils/audio.js';
import { sprites } from './sprites.js';
import { Lobby } from './lobby.js';
import { createLobbyView } from './ui/lobby.js';
import { createHud } from './ui/hud.js';
import { showError } from './ui/errorScreen.js';
import { startSession } from "./net/session.js";

const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');
const hud = document.getElementById('hud');

let canvasWidth, canvasHeight;

function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvasWidth = window.innerWidth;
    canvasHeight = window.innerHeight;
    canvas.width = canvasWidth * dpr;
    canvas.height = canvasHeight * dpr;
    canvas.style.width = `${canvasWidth}px`;
    canvas.style.height = `${canvasHeight}px`;
    ctx.scale(dpr, dpr);
}

window.addEventListener('resize', resize);
resize();

const input = createInput();
const world = new World(canvasWidth, canvasHeight);
let ship = new Ship(canvasWidth / 2, canvasHeight / 2);
world.spawn(ship);

let playing = false;

window.addEventListener('keydown', (e) => {
    // Не стріляємо пробілом, коли пишемо повідомлення в чаті
    if (document.activeElement && (document.activeElement.id === 'chatInput' || document.activeElement.tagName === 'INPUT')) {
        return;
    }

    if (e.code === 'Space' && playing) {
        ship.fire(world);
    }
});

let respawnTimer = 0;

function update(dt) {
    world.step(dt, input.getState());

    if (ship.isDead) {
        if (respawnTimer === 0) {
            respawnTimer = 2;
        }
        
        respawnTimer -= dt;
        
        if (respawnTimer <= 0) {
            ship = new Ship(canvasWidth / 2, canvasHeight / 2);
            world.spawn(ship);
            respawnTimer = 0;
        }
    }
    
    if (Math.random() < 0.02) {
        const asteroid = new Asteroid(Math.random() * canvasWidth, 0, 15);
        
        if (Math.random() < 0.2 && !ship.isDead) {
            world.spawn(withHoming(asteroid, ship, 50));
        } else {
            world.spawn(asteroid);
        }
    }
}

function draw(alpha) {
    world.render(ctx);
}

const hudView = createHud(hud);

const loop = createLoop(update, draw, {
    set innerText(text) {
        hudView.setPerf(text);
    }
});

const audioCtx = new AudioContext();
let assets = null;

function drawLoading(done, total, label) {
    ctx.save();
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvasWidth, canvasHeight);

    const barW = Math.min(400, canvasWidth * 0.6);
    const barH = 24;
    const x = (canvasWidth - barW) / 2;
    const y = canvasHeight / 2;

    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.strokeRect(x, y, barW, barH);

    ctx.fillStyle = '#0f0';
    ctx.fillRect(x, y, barW * (total ? done / total : 0), barH);

    ctx.fillStyle = '#fff';
    ctx.font = '16px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(`Завантаження ${done}/${total}  ${label}`, canvasWidth / 2, y - 16);

    ctx.restore();
}

function describeError(error) {
    if (error.name === 'AbortError') return 'Завантаження скасовано.';
    if (error.name === 'TimeoutError') return 'Сервер не відповів вчасно (таймаут).';
    if (error.name === 'HttpError') return `Файл не знайдено або помилка сервера (HTTP ${error.status}).`;
    if (error.name === 'SyntaxError') return 'Файл пошкоджений (некоректний JSON).';
    return "Не вдалося завантажити ресурси (перевірте з'єднання).";
}

function applyFailure(manifest, mode) {
    const m = structuredClone(manifest);
    if (mode === '404') m.images.hero = 'https://httpbin.org/status/404';
    if (mode === 'timeout') m.images.asteroid = 'https://httpbin.org/delay/10';
    if (mode === 'json') m.json.arena = '/assets/broken.json';
    return m;
}

function addChatMessageToBox(sender, text) {
    const chatMessages = document.getElementById('chatMessages');
    if (!chatMessages) return;

    const div = document.createElement('div');
    div.style.marginBottom = '4px';
    div.innerHTML = `<b style="color: #66fcf1;">${sender}:</b> ${text}`;
    chatMessages.appendChild(div);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

async function boot() {
    const params = new URLSearchParams(location.search);
    const failMode = params.get('fail');
    const delay = Number(params.get('delay')) || (failMode === 'abort' ? 800 : 0);

    const controller = new AbortController();

    try {
        drawLoading(0, 1, 'manifest');
        let manifest = await loadJson('/assets/manifest.json', controller.signal);
        manifest = applyFailure(manifest, failMode);

        if (failMode === 'abort') setTimeout(() => controller.abort(), 300);

        const options = {
            audioCtx,
            signal: controller.signal,
            debugDelayMs: delay,
            timeoutMs: 2000,
            onProgress: (done, total, name) => drawLoading(done, total, name),
        };

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

        assets = await loadAll(manifest, options);
        console.log('Ассети готові:', assets);

        initAudio(audioCtx, assets.sounds);
        Object.assign(sprites, assets.images);

        ctx.clearRect(0, 0, canvasWidth, canvasHeight);
        const lobby = new Lobby();
        const lobbyView = createLobbyView(lobby, document.getElementById('lobby'));

       lobby.addEventListener('joined', (e) => {
            const { room, name, arena } = e.detail;

            // 1. ПРИХОВУЄМО ЕКРАН ЛОБІ, щоб відкрити ігрове поле (Canvas)
            const lobbyEl = document.getElementById('lobby');
            if (lobbyEl) lobbyEl.style.display = 'none';
            if (typeof lobbyView.hide === 'function') {
                try { lobbyView.hide(); } catch (err) {}
            }

            // 2. Встановлюємо ім'я в HUD
            hudView.setName(name);

            // 3. Відкриваємо чат для гри
            const chatBox = document.getElementById('chatBox');
            if (chatBox) chatBox.style.display = 'block';

            // 4. Підключаємо мережеву сесію
            window.session = startSession({
                roomId: room ? room.id : 'Кімната 1',
                name,
                onRoaster: (m) => console.log('roster', m),
                onChat: (m) => {
                    console.log('chat', m);
                    if (m && m.text) {
                        addChatMessageToBox(m.sender || m.user || 'Гравець', m.text);
                    }
                },
                onStatus: (s, c) => console.log('status', s, c),
            });

            // 5. Запускаємо аудіо та ігровий цикл
            audioCtx.resume();
            
            const count = (arena && arena.asteroidCount) ? arena.asteroidCount : 5;
            for (let i = 0; i < count; i++) {
                world.spawn(new Asteroid(Math.random() * canvasWidth, Math.random() * canvasHeight * 0.5, 15));
            }
            
            playing = true;
            loop.start();
        });

        const chatForm = document.getElementById('chatForm');
        const chatInput = document.getElementById('chatInput');

        if (chatForm && chatInput) {
            chatForm.addEventListener('submit', (e) => {
                e.preventDefault();
                const text = chatInput.value.trim();
                if (text && window.session) {
                    if (typeof window.session.sendChat === 'function') {
                        window.session.sendChat(text);
                    } else if (typeof window.session.send === 'function') {
                        window.session.send(JSON.stringify({ type: 'chat', text }));
                    }
                    addChatMessageToBox('Ви', text);
                    chatInput.value = '';
                }
            });
        }

        lobbyView.show();
    } catch (error) {
        controller.abort();
        ctx.clearRect(0, 0, canvasWidth, canvasHeight);
        console.error('Збій завантаження:', error);

        showError(document.getElementById('errorScreen'), describeError(error), () => {
            history.replaceState(null, '', location.pathname);
            boot();
        });
    }
}

boot();