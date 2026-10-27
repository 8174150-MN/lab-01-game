// Оголошуємо функцію для зовнішніх файлів. Це створює ізольовану пам'ять
export function createInput() {
    // Створюємо словник для кнопок. Спочатку жодна з трьох стрілок не натиснута (false)
    const keys = { ArrowUp: false, ArrowLeft: false, ArrowRight: false };

    // Функція, яка спрацьовує при натисканні будь-якої клавіші (подія e)
    const onKeyDown = (e) => { 
        // Якщо натиснута клавіша є в нашому словнику, її стан стає true
        if (keys[e.code] !== undefined) keys[e.code] = true; 
    };
    
    // Функція, яка спрацьовує при відпусканні клавіші
    const onKeyUp = (e) => { 
        // Повертаємо стан кнопки у false
        if (keys[e.code] !== undefined) keys[e.code] = false; 
    };

    // Наказуємо браузеру завжди слухати події натискання та відпускання клавіатури
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);

    // Повертаємо об'єкт з методом getState. 
    // ({ ...keys }) створює і віддає безпечну копію стану кнопок, щоб ніхто не міг зламати оригінал
    return { getState: () => ({ ...keys }) };
}