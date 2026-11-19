import { writeFile } from 'node:fs/promises'; // Зберігаємо тільки виміряний звіт цього 30-секундного запуску.
import { fileURLToPath } from 'node:url'; // Перетворюємо URL артефакту на шлях Windows.
import { expect, test } from '@playwright/test'; // Відкриваємо справжню гру в браузері.

interface BrowserProfile {
  readonly durationSeconds: number;
  readonly frames: number;
  readonly frameMs: { readonly p50: number; readonly p95: number; readonly p99: number };
  readonly gc: { readonly supported: boolean; readonly pauses: number; readonly totalPauseMs: number };
}

interface SampleNode {
  readonly callFrame: { readonly functionName: string; readonly url: string };
  readonly selfSize: number;
  readonly children?: readonly SampleNode[];
}

interface SamplingProfile {
  readonly head: SampleNode;
}

interface CpuProfileNode {
  readonly id: number;
  readonly callFrame: { readonly functionName: string; readonly url: string };
}

interface CpuProfile {
  readonly nodes: readonly CpuProfileNode[];
  readonly samples: readonly number[];
  readonly timeDeltas: readonly number[];
}

interface GcTraceEvent {
  readonly category: string;
  readonly name: string;
  readonly durationUs: number;
}

test('records a 30 second game with eight server bots', async ({ page, context }) => {
  test.setTimeout(90_000); // Вимір триває 30 секунд, окремо лишаємо час на запуск браузера й серверів.
  const profileMode = process.env.LAB7_PROFILE_MODE === 'before' ? 'before' : 'after'; // Дозволяємо повторити baseline і оптимізований варіант з однаковим сценарієм.
  const profileSuffix = profileMode === 'before' ? '-before' : ''; // Стандартні назви завжди відповідають фінальній версії.
  let report: BrowserProfile | null = null; // Тут зберігаємо фактичний результат із браузерної консолі.
  let resolveReport: ((value: BrowserProfile) => void) | null = null; // Очікуємо один завершений профіль.
  let rejectReport: ((reason: Error) => void) | null = null; // Повідомляємо помилку, якщо probe не завершується.
  const reportReady = new Promise<BrowserProfile>((resolve, reject) => {
    resolveReport = resolve; // Зберігаємо завершальний callback до запуску сторінки.
    rejectReport = reject; // Зберігаємо помилковий callback для timeout.
  }); // Створюємо promise до події console.
  page.on('console', (message) => {
    const text = message.text(); // Читаємо надруковану браузером діагностику.
    const prefix = '[Lab 7 profile] '; // Відокремлюємо звіт probe від звичайних повідомлень гри.
    if (!text.startsWith(prefix)) return; // Ігноруємо звичайний HUD і повідомлення браузера.
    try {
      report = JSON.parse(text.slice(prefix.length)) as BrowserProfile; // Розбираємо конкретне повідомлення профайлера.
      resolveReport?.(report); // Розблоковуємо очікування після 30 секунд.
    } catch {
      rejectReport?.(new Error('Browser profile returned invalid JSON')); // Не записуємо пошкоджений звіт як результат.
    }
  }); // Підписуємося на один виміряний результат.

  const captureDevTools = process.env.LAB7_PROFILE_CAPTURE !== '0'; // Окремий режим вимірює FPS без CPU/heap семплера.
  const cdp = captureDevTools ? await context.newCDPSession(page) : null; // Під'єднуємо DevTools лише для повного профілю.
  if (cdp) {
    await cdp.send('Profiler.enable'); // Готуємо збір стеків CPU для матчу.
    await cdp.send('HeapProfiler.enable'); // Готуємо вибірковий запис алокацій.
  }
  const gcTraceEvents: GcTraceEvent[] = []; // Зберігаємо тільки завершені GC-паузи, а не весь trace.
  if (cdp) {
    cdp.on('Tracing.dataCollected', (batch) => {
      for (const event of batch.value) {
        if ((event.name !== 'MajorGC' && event.name !== 'MinorGC') || event.ph !== 'X' || typeof event.dur !== 'number')
          continue; // Беремо підсумкові паузи, а не фази паралельного GC.
        gcTraceEvents.push({ category: event.cat, name: event.name, durationUs: event.dur }); // Переводимо сирий trace у компактний звіт.
      } // Завершуємо обробку чергового пакета Chrome trace.
    }); // Починаємо збирати тільки події збирання сміття.
  }
  const traceComplete = cdp
    ? new Promise<void>((resolve) => cdp.once('Tracing.tracingComplete', () => resolve()))
    : Promise.resolve(); // Без DevTools немає trace, на який потрібно чекати.
  const baselineQuery = profileMode === 'before' ? '&lab7-render-baseline=1' : ''; // У baseline повертаємо старі Map/Set/Array пошуки.
  await page.goto('/?lab7-profile=1&lab7-e2e=1' + baselineQuery); // Вмикаємо вимір і контрольний режим лише за його параметром.
  await page.getByRole('button', { name: 'Почати' }).click(); // Розблоковуємо Web Audio і починаємо завантаження.
  await expect(page.locator('#lobby')).toBeVisible(); // Дочікуємося появи лобі.
  await page.locator('#lobby-name').fill('Profile Observer'); // Задаємо ім'я браузерного спостерігача.
  const roomInput = page.locator('#lobby-rooms input[type="radio"]').first(); // Обираємо кімнату, створену під час запуску сервера.
  await expect(roomInput).toBeVisible(); // Чекаємо на дані кімнати з API.
  await roomInput.check(); // Обираємо цю кімнату в лобі.
  const roomsResponse = await page.request.get('/api/rooms'); // Читаємо ID тієї самої кімнати зі справжнього API.
  const rooms: Array<{ id: string }> = await roomsResponse.json(); // Витягуємо список типових кімнат.
  const roomId = rooms[0]?.id; // Перше radio відповідає першій кімнаті у списку.
  if (!roomId) throw new Error('Lobby API returned no room id'); // Не починаємо вимір без валідної кімнати.
  await page.locator('#net-authoritative').check(); // Обираємо серверну симуляцію, яку профілює методичка.
  const botsResponse = await page.request.post('/api/rooms/' + encodeURIComponent(roomId) + '/bots', {
    data: { count: 8 },
  }); // Додаємо вісім server-side AI до початку вимірюваного матчу.
  expect(botsResponse.status()).toBe(201); // Перевіряємо відповідь API до важкого виміру.
  await page.locator('#lobby-join').click(); // Входимо в гру й одразу запускаємо 30-секундний frame probe.
  await expect(page.locator('#chatBox')).toBeVisible(); // Підтверджуємо, що матч стартував.
  if (cdp) {
    await cdp.send('Profiler.start'); // Починаємо CPU profile після лобі та завантаження assets.
    await cdp.send('HeapProfiler.startSampling', { samplingInterval: 32_768 }); // Вибираємо алокації лише під час матчу.
    await cdp.send('Tracing.start', {
      categories: 'v8',
      transferMode: 'ReportEvents',
    }); // Вмикаємо Chrome trace для точних тривалостей GC-пауз.
  }

  const timeout = setTimeout(() => rejectReport?.(new Error('30 second browser profile timed out')), 60_000); // Не чекаємо нескінченно, якщо вкладка зупинила rAF.
  try {
    report = await reportReady; // Даємо браузеру рівно завершити власний 30-секундний збір.
  } finally {
    clearTimeout(timeout); // Очищаємо запасний таймер після успіху або помилки.
  }
  expect(report.frames).toBeGreaterThan(100); // Перевіряємо, що браузер справді зафіксував багато кадрів.
  if (!cdp) {
    await writeFile(
      fileURLToPath(new URL('../server/bench/browser-profile-metrics-only.json', import.meta.url)),
      JSON.stringify({ ...report, bots: 8, note: 'Frame-only run without CPU or heap sampling.' }, null, 2) + '\n',
      'utf8',
    ); // Зберігаємо p50/p95/p99 окремо від інструментованого CPU профілю.
    console.log('[Browser frame metrics]', JSON.stringify(report)); // Показуємо вимір без DevTools семплера.
    return; // У цьому режимі більше не збираємо CPU, heap або GC trace.
  }
  const { profile } = await cdp.send('Profiler.stop'); // Завершуємо профіль V8, що відкривається у DevTools.
  const cpuProfile = profile as CpuProfile; // CDP повертає CPUProfile з вузлами, зразками й тривалостями.
  const cpuNodes = new Map(cpuProfile.nodes.map((node) => [node.id, node])); // Зіставляємо leaf-зразки з іменами функцій.
  const selfTimes = new Map<string, number>(); // Складаємо час, проведений безпосередньо у кожній функції.
  for (let index = 0; index < cpuProfile.samples.length; index += 1) {
    const nodeId = cpuProfile.samples[index]; // Кожен зразок указує на поточну функцію в стеку.
    const durationUs = cpuProfile.timeDeltas[index] ?? 0; // Зразок зберігає тривалість у мікросекундах.
    const node = nodeId === undefined ? undefined : cpuNodes.get(nodeId); // Знаходимо опис функції за ID.
    const functionName = node?.callFrame.functionName || '(anonymous)'; // Порожня назва позначається як анонімна.
    if (!node || functionName === '(idle)' || functionName === '(program)' || functionName === '(garbage collector)')
      continue; // Idle та GC мають окремий звіт, а не список коду.
    const label = functionName + ' ' + node.callFrame.url.split('/').pop(); // Зберігаємо функцію разом із короткою назвою файла.
    selfTimes.set(label, (selfTimes.get(label) ?? 0) + durationUs); // Додаємо виключно self time leaf-вузла.
  } // Завершуємо підрахунок часу функцій.
  const topSelfTime = [...selfTimes.entries()]
    .sort((first, second) => second[1] - first[1])
    .slice(0, 3)
    .map(([functionName, durationUs]) => ({ functionName, selfTimeMs: Number((durationUs / 1000).toFixed(2)) })); // Вибираємо три гарячі функції.
  await writeFile(
    fileURLToPath(new URL('../server/bench/browser-profile' + profileSuffix + '.cpuprofile', import.meta.url)),
    JSON.stringify(profile),
    'utf8',
  ); // Зберігаємо фактичні стеки функцій для Chrome/Edge Performance.
  const { profile: sampledHeap } = await cdp.send('HeapProfiler.stopSampling'); // Забираємо вибірку стеків створення об'єктів.
  await cdp.send('Tracing.end'); // Завершуємо instrumented GC trace разом із матчем.
  await traceComplete; // Дочікуємося всіх Chrome trace-пакетів.
  const gcTrace = {
    events: gcTraceEvents.length,
    majorGcs: gcTraceEvents.filter((event) => event.name === 'MajorGC').length,
    minorGcs: gcTraceEvents.filter((event) => event.name === 'MinorGC').length,
    totalPauseMs: Number((gcTraceEvents.reduce((total, event) => total + event.durationUs, 0) / 1000).toFixed(2)),
    maxPauseMs: Number((Math.max(0, ...gcTraceEvents.map((event) => event.durationUs)) / 1000).toFixed(2)),
  }; // Підсумовуємо фактичні тривалості пауз, а не лише вибіркові CPU-зразки.
  const heapProfile = sampledHeap as SamplingProfile; // CDP повертає цей об'єкт згідно з HeapSamplingProfile.
  const allocationSizes = new Map<string, number>(); // Підсумовуємо вибрані байти за функціями.
  function visitHeapNode(node: SampleNode): void {
    const label = (node.callFrame.functionName || '(anonymous)') + ' ' + node.callFrame.url; // Називаємо функцію та файл, де виникла алокація.
    allocationSizes.set(label, (allocationSizes.get(label) ?? 0) + node.selfSize); // Додаємо розмір вибраних об'єктів цієї функції.
    for (const child of node.children ?? []) visitHeapNode(child); // Обходимо вкладені стеки семплера.
  } // Завершуємо обхід одного вузла.
  visitHeapNode(heapProfile.head); // Починаємо аналіз з кореня sampling profile.
  const topAllocators = [...allocationSizes.entries()]
    .sort((first, second) => second[1] - first[1])
    .slice(0, 3)
    .map(([functionName, sampledBytes]) => ({ functionName, sampledBytes })); // Зберігаємо три найбільші вибіркові алокатори.
  await writeFile(
    fileURLToPath(new URL('../server/bench/browser-allocations' + profileSuffix + '.heapprofile', import.meta.url)),
    JSON.stringify(sampledHeap),
    'utf8',
  ); // Зберігаємо оригінальний профіль для Memory panel DevTools.
  await writeFile(
    fileURLToPath(new URL('../server/bench/browser-allocators' + profileSuffix + '.json', import.meta.url)),
    JSON.stringify(topAllocators, null, 2) + '\n',
    'utf8',
  ); // Записуємо три функції з найбільшим вибірковим обсягом алокацій.
  await writeFile(
    fileURLToPath(new URL('../server/bench/browser-hot-functions' + profileSuffix + '.json', import.meta.url)),
    JSON.stringify(topSelfTime, null, 2) + '\n',
    'utf8',
  ); // Зберігаємо три функції з найбільшим self time.
  await writeFile(
    fileURLToPath(new URL('../server/bench/browser-gc-trace' + profileSuffix + '.json', import.meta.url)),
    JSON.stringify(
      {
        ...gcTrace,
        events: gcTraceEvents.map((event) => ({ ...event, durationMs: Number((event.durationUs / 1000).toFixed(3)) })),
      },
      null,
      2,
    ) + '\n',
    'utf8',
  ); // Зберігаємо виміряні паузи GC та назви їхніх типів.
  await writeFile(
    fileURLToPath(new URL('../server/bench/browser-profile' + profileSuffix + '.json', import.meta.url)),
    JSON.stringify(
      {
        ...report,
        gcTrace,
        bots: 8,
        topAllocators,
        topSelfTime,
        note: 'Browser and machine dependent; one real 30-second run.',
      },
      null,
      2,
    ) + '\n',
    'utf8',
  ); // Записуємо кадри, GC та три виміряні функції-алокатори.
  console.log('[Browser profile]', JSON.stringify({ ...report, gcTrace, topAllocators, topSelfTime })); // Показуємо фактичні виміри у терміналі.
  await cdp.detach(); // Закриваємо з'єднання DevTools після вимірювання.
}); // Завершуємо 30-секундний профіль восьми AI ботів.
