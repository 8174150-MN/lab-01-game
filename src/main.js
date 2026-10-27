// Завантажуємо всі створені нами модулі
import { createInput } from './input.js';
import { integrate } from './physics.js';
import { render } from './render.js';
import { createLoop } from './loop.js';

// Знаходимо HTML-елементи полотна і тексту (HUD) за їхніми ID
const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d'); // Отримуємо пензлик для 2D-графіки
const hud = document.getElementById('hud');

let canvasWidth, canvasHeight;

// Функція, яка налаштовує розмір полотна під розмір вікна та щільність екрану (Retina/4K дисплеї)
function resize() {
    // Дізнаємось щільність пікселів (або 1 для звичайних екранів)
    const dpr = window.devicePixelRatio || 1;
    canvasWidth = window.innerWidth;
    canvasHeight = window.innerHeight;
    
    // Задаємо реальну фізичну кількість пікселів на полотні
    canvas.width = canvasWidth * dpr;
    canvas.height = canvasHeight * dpr;
    // Задаємо візуальний розмір полотна через CSS
    canvas.style.width = `${canvasWidth}px`;
    canvas.style.height = `${canvasHeight}px`;
    // Масштабуємо контекст (пензлик) під щільність екрану, щоб не було розмиття
    ctx.scale(dpr, dpr);
}

// Запускаємо перерахунок розмірів при старті та якщо користувач змінює розмір вікна браузера
window.addEventListener('resize', resize);
resize();

// Запускаємо "слухача" клавіатури, зберігаємо результат у змінну input
const input = createInput();

// Створюємо стартовий стан корабля рівно по центру екрану. Швидкості та кут дорівнюють 0
let ship = { x: canvasWidth / 2, y: canvasHeight / 2, vx: 0, vy: 0, angle: 0, isThrusting: false };
// Створюємо копію для зберігання попереднього стану (потрібно для плавного малювання)
let previousShip = { ...ship };

// Функція, яку ігровий цикл викликає виключно для розрахунку математики та фізики
function update(dt) {
    // Зберігаємо старий стан корабля перед змінами
    previousShip = { ...ship };
    // Викликаємо розрахунок нової фізики на основі натиснутих кнопок (input.getState())
    ship = integrate(ship, input.getState(), dt, canvasWidth, canvasHeight);
}

// Функція малювання екрану. Alpha - це відсоток часу між старим і новим кадром фізики
function draw(alpha) {
    // Інтерполяція: знаходимо ідеальну візуальну позицію між старим і новим кадром (особливо важливо для 144Hz екранів)
    let renderX = previousShip.x + (ship.x - previousShip.x) * alpha;
    let renderY = previousShip.y + (ship.y - previousShip.y) * alpha;

    // Захист від багів: якщо корабель щойно телепортувався через край екрану, 
    // вимикаємо плавність на цей кадр, щоб він не пролетів лінією через всю карту
    if (Math.abs(ship.x - previousShip.x) > canvasWidth / 2) renderX = ship.x;
    if (Math.abs(ship.y - previousShip.y) > canvasHeight / 2) renderY = ship.y;

    // Збираємо тимчасовий віртуальний корабель для малювання
    const renderShip = { ...ship, x: renderX, y: renderY, 
        angle: previousShip.angle + (ship.angle - previousShip.angle) * alpha 
    };
    
    // Виводимо наш віртуальний корабель на полотно
    render(ctx, renderShip, canvasWidth, canvasHeight);
}

// Створюємо ігровий цикл, передаємо йому функції оновлення/малювання та стартуємо гру
createLoop(update, draw, hud).start();