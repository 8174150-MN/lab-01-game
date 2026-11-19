import { readFile, writeFile } from 'node:fs/promises'; // Читаємо фактичний профіль і зберігаємо побудований flame chart.
import { fileURLToPath } from 'node:url'; // Показуємо шлях у звичному форматі для поточної ОС.
import { basename } from 'node:path'; // Назва файлу визначає назву summary-артефакту.

const profilePath = new URL(process.argv[2] ?? './browser-profile.cpuprofile', import.meta.url); // Можна окремо збудувати baseline або фінальний профіль.
const svgPath = new URL(process.argv[3] ?? './browser-profile-flame.svg', import.meta.url); // Зберігаємо flame chart під відповідною назвою.
const profileName = basename(fileURLToPath(profilePath)).replace(/\.cpuprofile$/i, ''); // Вилучаємо суфікс, щоб підписати дочірні результати.
const summaryPath = new URL('./' + profileName + '-hot-functions.json', import.meta.url); // Self-time зберігається поруч із flame chart.
const profileTitle = profileName.startsWith('server-')
  ? 'Node.js CPU flame chart · вісім headless клієнтів · активні зразки '
  : 'Browser CPU flame chart · вісім серверних ботів · активні зразки '; // Заголовок відрізняє server profile від browser profile.
const profile = JSON.parse(await readFile(profilePath, 'utf8')); // Розбираємо JSON, який повернув Chrome DevTools Protocol.
if (!Array.isArray(profile.nodes) || !Array.isArray(profile.samples) || !Array.isArray(profile.timeDeltas)) {
  throw new Error('The CPU profile does not contain samples and time deltas'); // Не малюємо графік із неповного профілю.
} // Завершуємо перевірку потрібних полів профілю.

const byId = new Map(profile.nodes.map((node) => [node.id, node])); // Зіставляємо sample id з описом функції.
const parentById = new Map(); // Пам'ятаємо батька кожного вузла для відновлення стеку.
for (const node of profile.nodes) {
  for (const childId of node.children ?? []) parentById.set(childId, node.id); // Записуємо зв'язок батько-дитина.
} // Завершуємо індексування дерева стеків.

const root = { name: 'JavaScript', value: 0, self: 0, children: new Map() }; // Створюємо корінь агрегованого flame graph.
const selfTimes = new Map(); // Складаємо час функцій за листовими CPU-зразками.
let sampledBusyUs = 0; // Сумуємо тільки активні зразки, без часу очікування браузера.
for (let index = 0; index < profile.samples.length; index += 1) {
  const leafId = profile.samples[index]; // Поточний зразок указує на вершину стека.
  const durationUs = profile.timeDeltas[index]; // Кожен зразок має тривалість у мікросекундах.
  const leafNode = byId.get(leafId); // Leaf функція отримала безпосередній CPU час зразка.
  if (leafNode) {
    const functionName = leafNode.callFrame.functionName || '(anonymous)'; // Відсутнє ім'я позначаємо як anonymous.
    if (
      functionName !== '(idle)' &&
      functionName !== '(program)' &&
      functionName !== '(root)' &&
      functionName !== '(garbage collector)'
    ) {
      const label = functionName + (leafNode.callFrame.url ? ' · ' + leafNode.callFrame.url.split('/').pop() : ''); // Скорочуємо шлях для звіту.
      selfTimes.set(label, (selfTimes.get(label) ?? 0) + durationUs); // Накопичуємо лише власний час функції.
    }
  }
  const stack = []; // Відновлюємо шлях від поточної функції до кореня.
  let currentId = leafId; // Починаємо з leaf, який записав CPU profiler.
  while (currentId !== undefined) {
    const node = byId.get(currentId); // Знаходимо назву функції.
    if (!node) break; // Захищаємо звіт від пошкодженого ID.
    const name = node.callFrame.functionName || '(anonymous)'; // Порожнє ім'я показуємо як анонімний callback.
    if (name === '(idle)' || name === '(program)' || name === '(root)') break; // Час простою не є роботою JavaScript гри.
    stack.push({ name: name + (node.callFrame.url ? ' · ' + node.callFrame.url.split('/').pop() : ''), id: currentId }); // Зберігаємо короткий підпис функції.
    currentId = parentById.get(currentId); // Переходимо до наступного виклику вгору.
  } // Завершуємо відновлення одного стека.
  if (stack.length === 0 || durationUs <= 0) continue; // Пропускаємо idle й порожні зразки.
  sampledBusyUs += durationUs; // Рахуємо активний час, який відображатиме ширина графіка.
  let branch = root; // Вставляємо стек згори вниз у дерево агрегованих викликів.
  branch.value += durationUs; // Кожен батько включає час своїх вкладених функцій.
  for (let depth = stack.length - 1; depth >= 0; depth -= 1) {
    const frame = stack[depth]; // Починаємо з найдавнішого виклику у стеку.
    if (!frame) continue; // Перевірка індексу потрібна для noUncheckedIndexedAccess.
    let child = branch.children.get(frame.name); // Шукаємо вже намальовану таку саму гілку.
    if (!child) {
      child = { name: frame.name, value: 0, self: 0, children: new Map() }; // Створюємо вузол для нової функції.
      branch.children.set(frame.name, child); // Додаємо вузол до дерева.
    }
    child.value += durationUs; // Додаємо час зразка до всіх функцій у стеку.
    branch = child; // Переходимо до дочірнього кадру.
  } // Завершуємо накопичення часу всіх рівнів стеку.
  branch.self += durationUs; // Останній кадр отримує власний час цього зразка.
} // Завершуємо агрегацію всіх V8 CPU samples.

const topSelfTime = [...selfTimes.entries()]
  .sort((first, second) => second[1] - first[1])
  .slice(0, 3)
  .map(([functionName, durationUs]) => ({ functionName, selfTimeMs: Number((durationUs / 1000).toFixed(2)) })); // Вибираємо три функції з найбільшим власним часом.
await writeFile(summaryPath, JSON.stringify(topSelfTime, null, 2) + '\n', 'utf8'); // Зберігаємо hot functions окремим читабельним файлом.

function depthOf(node) {
  if (node.children.size === 0) return 1; // Листок займає один рядок графіка.
  return 1 + Math.max(...[...node.children.values()].map(depthOf)); // Вибираємо найдовший вкладений стек.
} // Завершуємо підрахунок висоти flame chart.

function colorFor(name) {
  let hash = 0; // Починаємо стабільний hash підпису функції.
  for (const character of name) hash = (hash * 31 + character.charCodeAt(0)) >>> 0; // Та сама функція має той самий колір.
  return 'hsl(' + (hash % 360) + ' 62% 48%)'; // Різні функції читаються як окремі блоки.
} // Завершуємо вибір кольору.

const width = 1600; // Ширина PNG, щоб довгі назви функцій лишалися читабельними.
const rowHeight = 23; // Висота одного stack frame.
const topPadding = 58; // Залишаємо місце під назву та сумарний активний час.
const chartHeight = Math.max(300, depthOf(root) * rowHeight); // Висота залежить від максимальної глибини стеку.
const elements = []; // Складаємо SVG-вузли лише під час побудови офлайн-звіту.

function renderNode(node, x, availableWidth, depth) {
  let childX = x; // Дочірні блоки розкладаються поруч пропорційно часу.
  for (const child of node.children.values()) {
    const childWidth = (availableWidth * child.value) / Math.max(1, node.value); // Ширина відповідає часу цієї гілки.
    if (childWidth < 1) continue; // Не додаємо субпіксельні блоки, які не видно.
    const drawY = topPadding + chartHeight - (depth + 1) * rowHeight; // Корінь показуємо внизу, виклики над ним.
    const label = child.name.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'); // Екрануємо підпис для SVG.
    const title =
      label + ' · total ' + (child.value / 1000).toFixed(1) + ' ms · self ' + (child.self / 1000).toFixed(1) + ' ms'; // Підказка містить inclusive та self time.
    elements.push(
      '<g><title>' +
        title +
        '</title><rect x="' +
        childX.toFixed(2) +
        '" y="' +
        drawY +
        '" width="' +
        Math.max(0.5, childWidth - 1).toFixed(2) +
        '" height="' +
        (rowHeight - 2) +
        '" rx="2" fill="' +
        colorFor(child.name) +
        '"/><text x="' +
        (childX + 4).toFixed(2) +
        '" y="' +
        (drawY + 15) +
        '" fill="#fff" font-size="11" font-family="Segoe UI, sans-serif">' +
        (childWidth > 95 ? label.slice(0, 72) : '') +
        '</text></g>',
    ); // Малюємо блок і підказку часу.
    renderNode(child, childX, childWidth, depth + 1); // Рекурсивно малюємо вкладені функції.
    childX += childWidth; // Переходимо до наступної гілки дерева.
  } // Завершуємо сусідні виклики поточного вузла.
} // Завершуємо малювання одного стека.

renderNode(root, 0, width, 0); // Малюємо всі зібрані стеки у часовому порядку гілок.
const svg =
  '<svg xmlns="http://www.w3.org/2000/svg" width="' +
  width +
  '" height="' +
  (chartHeight + topPadding + 28) +
  '" viewBox="0 0 ' +
  width +
  ' ' +
  (chartHeight + topPadding + 28) +
  '"><rect width="100%" height="100%" fill="#0b0c10"/><text x="20" y="28" fill="#fff" font-size="20" font-family="Segoe UI, sans-serif">' +
  profileTitle +
  (sampledBusyUs / 1000).toFixed(1) +
  ' мс</text><text x="20" y="48" fill="#aeb9c9" font-size="12" font-family="Segoe UI, sans-serif">Ширина показує вибірковий час у стеку; наведіть курсор на блок, щоб побачити self та total time.</text>' +
  elements.join('') +
  '</svg>'; // Складаємо автономний flame chart із вимірів V8.
await writeFile(svgPath, svg, 'utf8'); // Зберігаємо масштабований варіант у репозиторії.
console.log('Збережено ' + fileURLToPath(svgPath) + ' з ' + profile.samples.length + ' CPU samples.'); // Виводимо фактичний шлях, включно з baseline графіком.
console.log('Hot functions: ' + fileURLToPath(summaryPath)); // Показуємо окремий звіт self-time.
