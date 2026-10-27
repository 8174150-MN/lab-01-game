import { Entity } from './entity.js';
import { Vector2 } from './math.js';
import { withPickup } from './components.js';

// Клас корабля гравця (наслідує все від базового Entity)
export class Ship extends Entity {
    #hp; // Секретна кількість здоров'я (життів) корабля

    constructor(x, y) {
        super(x, y, 15, 'ship'); // Викликаємо конструктор бази (Entity) з радіусом 15 і типом 'ship'
        this.angle = 0;          // Початковий кут повороту корабля
        this.isThrusting = false; // Чи натиснута кнопка газу (для вогню з двигуна)
        this.#hp = 3;            // Починаємо гру з 3 життями
        this.cooldown = 0;       // Затримка між пострілами
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
    }

    // Малювання корабля на екрані (Canvas)
    render(ctx) {
        if (this.isDead) return;
        ctx.save();
        ctx.translate(this.pos.x, this.pos.y); // Переносимо центр малювання в точку корабля
        ctx.rotate(this.angle);                // Обертаємо малюнок за кутом корабля
        
        // Малюємо трикутний корпус
        ctx.beginPath();
        ctx.moveTo(20, 0); ctx.lineTo(-15, -15); ctx.lineTo(-10, 0); ctx.lineTo(-15, 15);
        ctx.closePath();
        ctx.strokeStyle = '#00ffcc'; ctx.lineWidth = 2; ctx.stroke();
        
        // Малюємо вогонь з двигуна, якщо натиснута стрілка вгору
        if (this.isThrusting) {
            ctx.beginPath(); ctx.moveTo(-12, 0); ctx.lineTo(-25 - Math.random() * 10, 0);
            ctx.strokeStyle = '#ff6600'; ctx.stroke();
        }
        ctx.restore();
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
        ctx.beginPath(); ctx.arc(this.pos.x, this.pos.y, this.radius, 0, Math.PI * 2);
        ctx.fillStyle = '#ff0'; ctx.fill(); // Малюємо жовту крапку
    }
}

// Клас астероїда
export class Asteroid extends Entity {
    constructor(x, y, radius) {
        super(x, y, radius, 'asteroid');
        this.vel = new Vector2((Math.random() - 0.5) * 100, (Math.random() - 0.5) * 100); // Летить випадково
    }
    render(ctx) {
        ctx.beginPath(); ctx.arc(this.pos.x, this.pos.y, this.radius, 0, Math.PI * 2);
        ctx.strokeStyle = '#aaa'; ctx.lineWidth = 2; ctx.stroke(); // Малюємо сіре коло
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