import { defineConfig } from 'eslint/config'; // Використовуємо flat-конфіг ESLint 10.

const browserNames = [
  // Збираємо API браузера, які використовують клієнтські модулі.
  'window',
  'document',
  'navigator',
  'location',
  'requestAnimationFrame',
  'cancelAnimationFrame', // Додаємо вікно, DOM і кадровий цикл.
  'devicePixelRatio',
  'performance',
  'AudioContext',
  'CustomEvent',
  'EventTarget',
  'AbortController',
  'AbortSignal', // Додаємо графіку, звук і події браузера.
  'fetch',
  'createImageBitmap',
  'WebSocket',
  'URLSearchParams',
  'Blob',
  'Image',
  'TextEncoder',
  'TextDecoder', // Додаємо мережу, зображення, сокети й кодування тексту.
  'console',
  'setTimeout',
  'clearTimeout',
  'setInterval',
  'clearInterval',
  'URL', // Додаємо діагностику, таймери та парсер адрес.
]; // Завершуємо список глобалів браузера.

const nodeNames = ['process', 'Buffer', '__dirname']; // Додаємо глобали Node.js, яких немає в ESM автоматично.
const readonly = (names) => Object.fromEntries(names.map((name) => [name, 'readonly'])); // Позначаємо API як доступні, але незмінні.

export default defineConfig([
  // Експортуємо спільні правила для клієнта, сервера та тестів.
  { ignores: ['**/node_modules/**', '**/dist/**', '**/logs/**', 'package-lock.json'] }, // Не перевіряємо залежності та створені файли.
  {
    // Починаємо конфігурацію JavaScript-файлів.
    files: ['**/*.js'], // Включаємо вихідний код, конфігурацію та тести.
    languageOptions: {
      // Налаштовуємо версію мови й доступні глобальні імена.
      ecmaVersion: 'latest', // Дозволяємо синтаксис актуального JavaScript.
      sourceType: 'module', // Проєкт використовує ES-модулі.
      globals: { ...readonly(browserNames), ...readonly(nodeNames) }, // Додаємо середовища обох частин проєкту.
    }, // Завершуємо параметри мови.
    rules: {
      // Вмикаємо правила, що ловлять дефекти, а не стиль.
      'no-constant-condition': 'error', // Забороняємо випадкові незмінні умови циклів.
      'no-dupe-keys': 'error', // Забороняємо дублікати ключів у літералах об'єктів.
      'no-unreachable': 'error', // Знаходимо код, до якого виконання не може дійти.
      'no-undef': 'error', // Знаходимо помилки в іменах змінних та API середовищ.
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }], // Не лишаємо випадкові невикористані змінні.
    }, // Завершуємо набір правил.
  }, // Завершуємо конфігурацію JavaScript.
]); // Завершуємо flat-конфіг.
