export function createLoop(updateFn, renderFn, hudElement) {
    const dt = 1 / 60; // Фіксуємо крок фізики: рівно 60 разів на секунду
    
    let accumulator = 0; // Змінна-копилка, яка накопичує час, що пройшов між кадрами екрану
    let lastTime = performance.now(); // Запам'ятовуємо час старту циклу
    
    let frames = 0, steps = 0;
    let lastHudTime = lastTime;

    // Головна функція циклу, яка синхронізується з оновленням монітора
    function frame(currentTime) {
        // Відразу плануємо виклик цієї ж функції для наступного кадру (перед малюванням)
        requestAnimationFrame(frame);
        
        // Вираховуємо, скільки часу пройшло з моменту попереднього кадру (у секундах)
        let frameTime = (currentTime - lastTime) / 1000;
        lastTime = currentTime;
        
        // Захист від зависання: якщо вкладка браузера була неактивна, обрізаємо час, щоб гра не намагалась прорахувати тисячі кроків
        if (frameTime > 0.25) frameTime = 0.25;
        
        accumulator += frameTime; // Додаємо пройдений час у копилку

        // Доки в копилці є час на повний розрахунковий крок (1/60 с), запускаємо логіку фізики
        while (accumulator >= dt) {
            updateFn(dt);      // Робимо крок розрахунків
            accumulator -= dt; // Віднімаємо витрачений час з копилки
            steps++;           // Рахуємо, скільки кроків фізики зроблено за кадр
        }

        // Рахуємо залишок часу в копилці (від 0 до 1), який потрібен для плавного малювання
        const alpha = accumulator / dt;
        
        // Малюємо графіку з урахуванням цього залишку (інтерполяція)
        renderFn(alpha);
        frames++; // Рахуємо намальовані кадри

        // Раз на секунду оновлюємо блок статистики (HUD) у кутку екрану
        if (currentTime - lastHudTime >= 1000) {
            hudElement.innerText = `FPS: ${frames} | Steps/s: ${steps} | Frame: ${(frameTime*1000).toFixed(1)}ms`;
            frames = 0; steps = 0; // Скидаємо лічильники для наступної секунди
            lastHudTime = currentTime;
        }
    }
    
    // Віддаємо об'єкт з функцією start, яка початково запускає наш ігровий цикл
    return { start: () => { lastTime = performance.now(); requestAnimationFrame(frame); } };
}