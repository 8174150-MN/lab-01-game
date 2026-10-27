// Чиста функція. Приймає координати, натиснуті кнопки, час між кадрами (dt) і розмір екрану
export function integrate(ship, input, dt, canvasWidth, canvasHeight) {
    // Створюємо повну копію корабля, щоб не мутувати оригінальний об'єкт (важливе правило чистої функції)
    const next = { ...ship }; 
    const rotationSpeed = 4; // Швидкість повороту корабля
    const thrust = 400;      // Сила двигуна (прискорення)

    // Змінюємо кут повороту наліво чи направо. Множимо на час (dt), щоб швидкість не залежала від FPS
    if (input.ArrowLeft) next.angle -= rotationSpeed * dt;
    if (input.ArrowRight) next.angle += rotationSpeed * dt;

    // Перевіряємо, чи затиснута кнопка газу (стрілка вгору)
    if (input.ArrowUp) {
        // Рахуємо прискорення по горизонталі через косинус кута і додаємо до швидкості
        next.vx += Math.cos(next.angle) * thrust * dt;
        // Рахуємо прискорення по вертикалі через синус кута
        next.vy += Math.sin(next.angle) * thrust * dt;
        // Вмикаємо прапорець для подальшого малювання полум'я з сопла
        next.isThrusting = true;
    } else {
        // Якщо газ не натиснуто, вимикаємо вогонь
        next.isThrusting = false;
    }

    // Імітація тертя у космосі. Швидкість постійно гаситься (множимо на 0.98), інакше корабель полетить безкінечно
    next.vx *= 0.98;
    next.vy *= 0.98;
    
    // Оновлюємо позицію корабля, додаючи швидкість до поточної координати
    next.x += next.vx * dt;
    next.y += next.vy * dt;

    // Загортання екрану: якщо вилетіли за лівий/правий/верхній/нижній край, з'являємось з іншого боку
    if (next.x < 0) next.x += canvasWidth;
    if (next.x > canvasWidth) next.x -= canvasWidth;
    if (next.y < 0) next.y += canvasHeight;
    if (next.y > canvasHeight) next.y -= canvasHeight;

    // Віддаємо нові пораховані координати назад у головну програму
    return next;
}