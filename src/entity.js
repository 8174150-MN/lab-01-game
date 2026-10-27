// Імпортуємо наш математичний клас для координат
import { Vector2 } from './math.js';

// Створюємо і експортуємо базовий клас Entity (Сутність)
export class Entity {
    // Статична змінна, яка є однаковою для всіх. Рахує загальні ID (номери) об'єктів
    static nextId = 1;
    
    // Приватна змінна #id (вимога). Ніхто зовні не може її випадково зламати чи змінити
    #id;

    // Конструктор створює кожну нову сутність
    constructor(x, y, radius, kind) {
        this.#id = Entity.nextId++;   // Даємо об'єкту унікальний номер і збільшуємо лічильник для наступного
        this.pos = new Vector2(x, y); // Де саме на екрані знаходиться об'єкт (координати)
        this.vel = new Vector2(0, 0); // З якою швидкістю і куди він летить
        this.radius = radius;         // Розмір кола об'єкта (потрібен для зіткнень)
        this.kind = kind;             // Текстовий тип ('ship' — корабель, 'asteroid' — астероїд тощо)
        this.isDead = false;          // Прапорець: чи знищено об'єкт (true/false)
    }

    // Спеціальний публічний інструмент (геттер), щоб безпечно прочитати секретний #id
    get id() { 
        return this.#id; 
    }

    // Як об'єкт рухається на кожному кадрі гри
    update(dt, canvasWidth, canvasHeight) {
        // Додаємо швидкість до поточної позиції з урахуванням часу (dt)
        this.pos = this.pos.add(this.vel.scale(dt));

        // Загортання країв екрана (Screen wrap-around):
        // Якщо об'єкт вилетів за лівий край екрана — він з'являється справа (і так для всіх стін)
        if (this.pos.x < 0) this.pos.x += canvasWidth;
        if (this.pos.x > canvasWidth) this.pos.x -= canvasWidth;
        if (this.pos.y < 0) this.pos.y += canvasHeight;
        if (this.pos.y > canvasHeight) this.pos.y -= canvasHeight;
    }
}