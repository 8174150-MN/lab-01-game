import { Entity } from './entity.js';
import { Vector2 } from './math.js';
import { withPickup } from './components.js';
import { emit } from './events.js';
import { sprites, drawSprite } from './sprites.js';

// Якщо картинка героя в файлі дивиться ВГОРУ, а не вправо, корабель
// летітиме боком. Тоді значення Math.PI / 2 (90 градусів) це правильна
// поправка. Якщо дивиться вправо,  0. 
const SPRITE_ROTATION = Math.PI / 2;

// Клас корабля гравця (наслідує все від базового Entity)
export class Ship extends Entity {
    #hp; // Секретна кількість здоров'я (життів) корабля

    constructor(x, y) {
        super(x, y, 15, 'ship'); // Викликаємо конструктор бази (Entity) з радіусом 15 і типом 'ship'
        this.angle = 0;          // Початковий кут повороту корабля
        this.isThrusting = false; // Чи натиснута кнопка газу (для вогню з двигуна)
        this.#hp = 3;            // Починаємо гру з 3 життями
        this.cooldown = 0;       // Затримка між пострілами
        emit('shipSpawned', { hp: this.#hp }); // новий корабель: HUD скидає життя
    }

    // Дозволяє подивитися поточну кількість життів
    get hp() { 
        return this.#hp; 
    }
    
    // Метод отримання шкоди
    takeDamage() {
        this.#hp--; // Віднімаємо 1 життя
        if (this.#hp <= 0) this.isDead = true; // Якщо життів не залишилось — корабель помер
    }
    
    // Метод лікування (додає життя при підборі аптечки)
    heal() { 
        this.#hp++; 
        emit('healed', { hp: this.#hp }); // HUD оновить життя
    }

    // Рух корабля від клавіатури
    update(dt, cw, ch, input) {
        if (this.isDead) return; // Якщо мертвий — нічого не робимо
        
        const rotationSpeed = 4; // Швидкість повороту
        const thrust = 400;      // Потужність прискорення

        // Поворот стрілками вліво/вправо
        if (input.ArrowLeft) this.angle -= rotationSpeed * dt;
        if (input.ArrowRight) this.angle += rotationSpeed * dt;

        // Газ при натисканні стрілки вгору
        if (input.ArrowUp) {
            // Рахуємо напрямок польоту за тригонометрією (косинус і синус кута)
            const thrustVec = new Vector2(Math.cos(this.angle), Math.sin(this.angle)).scale(thrust * dt);
            this.vel = this.vel.add(thrustVec); // Додаємо прискорення до швидкості
            this.isThrusting = true;            // Вмикаємо вогонь двигуна
        } else {
            this.isThrusting = false; // Вимикаємо вогонь
        }

        this.vel = this.vel.scale(0.98); // Космічне тертя (поступове сповільнення)
        if (this.cooldown > 0) this.cooldown -= dt; // Зменшуємо час очікування для наступного пострілу

        super.update(dt, cw, ch); // Викликаємо базовий рух і загортання стін з Entity
    }

    // Стрільба кулею з носа корабля
    fire(world) {
        if (this.isDead || this.cooldown > 0) return; // Якщо мертвий або кулдаун — не стріляємо
        
        // Рахуємо точні координати носа корабля за допомогою тригонометрії
        const noseX = this.pos.x + Math.cos(this.angle) * this.radius;
        const noseY = this.pos.y + Math.sin(this.angle) * this.radius;
        
        world.spawn(new Bullet(noseX, noseY, this.angle)); // Створюємо кулю у світі
        this.cooldown = 0.2; // Ставимо затримку 0.2 секунди перед наступним пострілом
     // Повідомляємо шину: постріл справді відбувся (звук підхопить audio.js).
        emit('fired');
    }

    // Малювання корабля на екрані (Canvas)
    render(ctx) {
        if (this.isDead) return;

        // Беремо картинку героя з полиці. Якщо вона не завантажилась,
        // тут буде undefined, і спрацює запасний варіант нижче.
        const img = sprites.hero;

        if (img) {
            // Висота на екрані: 3 радіуси. Ширину рахуємо за пропорціями картинки.
            const h = this.radius * 3;
            const w = h * (img.width / img.height);

            // Малюємо спрайт у позиції корабля, повернутий за кутом.
            drawSprite(ctx, img, this.pos.x, this.pos.y, w, h, this.angle + SPRITE_ROTATION);
        } else {
            // Запасний варіант: трикутник, як було раніше.
            ctx.save();
            ctx.translate(this.pos.x, this.pos.y);
            ctx.rotate(this.angle);
            ctx.beginPath();
            ctx.moveTo(20, 0); ctx.lineTo(-15, -15); ctx.lineTo(-10, 0); ctx.lineTo(-15, 15);
            ctx.closePath();
            ctx.strokeStyle = '#00ffcc'; ctx.lineWidth = 2; ctx.stroke();
            ctx.restore();
        }

        // Вогонь двигуна малюємо в обох випадках.
        if (this.isThrusting) {
            ctx.save();
            ctx.translate(this.pos.x, this.pos.y);
            ctx.rotate(this.angle);
            ctx.beginPath();
            ctx.moveTo(-this.radius, 0);
            ctx.lineTo(-this.radius - 10 - Math.random() * 10, 0);
            ctx.strokeStyle = '#ff6600'; ctx.lineWidth = 2; ctx.stroke();
            ctx.restore();
        }
    }
}

// Клас кулі
export class Bullet extends Entity {
    constructor(x, y, angle) {
        super(x, y, 2, 'bullet'); // Маленький радіус 2, тип 'bullet'
        const speed = 500;
        this.vel = new Vector2(Math.cos(angle) * speed, Math.sin(angle) * speed); // Летить швидко у потрібному напрямку
        this.ttl = 1.5; // Time To Live: час життя кулі (1.5 секунды, після чого вона зникне)
    }

    update(dt, cw, ch) {
        this.ttl -= dt; // Зменшуємо час життя
        if (this.ttl <= 0) this.isDead = true; // Час вийшов — знищуємо кулю
        super.update(dt, cw, ch);
    }
    render(ctx) {
        const img = sprites.bullets;
        if (img) {
            // Спрайтшит: 4 кадри по 32 пікселі в один ряд. Номер кадру
            // залежить від віку кулі (12 кадрів на секунду), % 4 зациклює.
            const frameIndex = Math.floor((1.5 - this.ttl) * 12) % 4;
            drawSprite(ctx, img, this.pos.x, this.pos.y, 16, 16, 0,
                       { x: frameIndex * 32, y: 0, w: 32, h: 32 });
        } else {
            // Запасний варіант: жовта крапка, як раніше.
            ctx.beginPath(); ctx.arc(this.pos.x, this.pos.y, this.radius, 0, Math.PI * 2);
            ctx.fillStyle = '#ff0'; ctx.fill();
        }
    
    }
}

// Клас астероїда
export class Asteroid extends Entity {
    constructor(x, y, radius) {
        super(x, y, radius, 'asteroid');
        this.vel = new Vector2((Math.random() - 0.5) * 100, (Math.random() - 0.5) * 100); // Летить випадково
    }
       render(ctx) {
        const img = sprites.asteroid;

        if (img) {
            // Діаметр спрайта трохи більший за коло зіткнення (радіус * 2.4).
            const size = this.radius * 2.4;
            drawSprite(ctx, img, this.pos.x, this.pos.y, size, size);
        } else {
            // Запасний варіант: сіре коло.
            ctx.beginPath(); ctx.arc(this.pos.x, this.pos.y, this.radius, 0, Math.PI * 2);
            ctx.strokeStyle = '#aaa'; ctx.lineWidth = 2; ctx.stroke();
        }
    }
}

// Клас частинки вибуху
export class Particle extends Entity {
    constructor(x, y) {
        super(x, y, 1, 'particle');
        this.vel = new Vector2((Math.random() - 0.5) * 200, (Math.random() - 0.5) * 200); // Розлітаються в різні боки
        this.ttl = 0.5 + Math.random() * 0.5; // Живуть дуже короткий час
    }
    update(dt, cw, ch) {
        this.ttl -= dt;
        if (this.ttl <= 0) this.isDead = true;
        super.update(dt, cw, ch);
    }
    render(ctx) {
        ctx.fillStyle = `rgba(255, 100, 0, ${this.ttl})`; // Прозорість падає з часом (згасання)
        ctx.fillRect(this.pos.x, this.pos.y, 3, 3);
    }
}

// Фабрична функція для створення аптечки з використанням композиції withPickup
export function createHealthPickup(x, y) {
    const e = new Entity(x, y, 8, 'pickup');
    e.render = (ctx) => {
        ctx.fillStyle = '#0f0';
        ctx.fillRect(e.pos.x - 4, e.pos.y - 4, 8, 8); // Малюємо зелений квадрат
    };
    return withPickup(e, (ship) => {
        ship.heal();       // Додаємо кораблю здоров'я
        e.isDead = true;   // Видаляємо аптечку після підбору
    });
}