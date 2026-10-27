// Функція композиції 1: робить будь-який об'єкт самонавідним (він починає летіти за кораблем)
export function withHoming(entity, targetEntity, speed) {
    // Зберігаємо старий метод руху об'єкта, щоб не втратити його
    const originalUpdate = entity.update.bind(entity);
    
    // Перевизначаємо метод руху спеціально для цього конкретного об'єкта
    entity.update = (dt, cw, ch) => {
        // Якщо ціль (корабель) існує і вона жива
        if (targetEntity && !targetEntity.isDead) {
            // Шукаємо напрямок до корабля і підштовхуємо туди об'єкт
            const dir = targetEntity.pos.sub(entity.pos).normalize();
            entity.vel = entity.vel.add(dir.scale(speed * dt));
        }
        originalUpdate(dt, cw, ch); // Викликаємо звичайний рух і перетин стін
    };
    return entity; // Повертаємо оновлений об'єкт
}

// Функція композиції 2: перетворює об'єкт на бонус (аптечку), яку можна підібрати
export function withPickup(entity, onPickupFn) {
    entity.onPickup = onPickupFn; // Зберігаємо дію, яка станеться при торканні до корабля
    return entity;
}