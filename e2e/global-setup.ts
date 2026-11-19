import { spawn, type ChildProcess } from 'node:child_process'; // Запускаємо Node/Vite напряму, без npm оболонок.
import { fileURLToPath } from 'node:url'; // Перетворюємо ESM URL-и на шляхи Windows.
import type { FullConfig } from '@playwright/test'; // Типізуємо setup, який Playwright викликає перед тестами.

// Чекаємо на готовність HTTP сервісу або пояснюємо, який процес завершився.
async function waitForReady(url: string, child: ChildProcess, label: string): Promise<void> {
  const deadline = Date.now() + 30_000; // Обмежуємо час запуску на повільному комп'ютері.
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(label + ' exited before becoming ready (code ' + child.exitCode + ')'); // Не чекаємо таймаут, якщо процес уже впав.
    try {
      const response = await fetch(url); // Перевіряємо реальну HTTP відповідь.
      if (response.ok) return; // Продовжуємо лише після успішного health/page response.
    } catch {
      // Сервер ще стартує, тому повторюємо коротку перевірку.
    } // Завершуємо обробку ще не готової адреси.
    await new Promise<void>((resolve) => setTimeout(resolve, 200)); // Не створюємо інтенсивний цикл опитування.
  } // Завершуємо період очікування.
  throw new Error(label + ' did not become ready at ' + url); // Пояснюємо адресу й процес, що не стартував.
} // Завершуємо очікування сервісу.

// Зупиняємо прямий дочірній процес і маємо обмежений запасний примусовий вихід.
async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.killed) return; // Не надсилаємо сигнал уже зупиненому процесу.
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL'); // Прибираємо процес, якщо штатне завершення зависло.
      resolve(); // Не залишаємо teardown безмежно чекати.
    }, 3000); // Відводимо час на закриття логів і сокетів.
    child.once('exit', () => {
      clearTimeout(timer); // Не запускаємо примусове завершення після чистого виходу.
      resolve(); // Підтверджуємо завершення дочірнього процесу.
    }); // Реагуємо на фактичне завершення процесу.
    child.kill('SIGTERM'); // Просимо сервер і Vite завершити роботу.
  }); // Завершуємо очікування виходу.
} // Завершуємо керовану зупинку процесу.

// Піднімаємо застосунок перед Playwright і повертаємо симетричне очищення після нього.
export default async function globalSetup(_config: FullConfig): Promise<() => Promise<void>> {
  const serverDirectory = fileURLToPath(new URL('../server/', import.meta.url)); // Сервер очікує запуску зі своєї папки.
  const clientDirectory = fileURLToPath(new URL('../client/', import.meta.url)); // Vite має коренем папку клієнта.
  const serverPort = process.env.LAB7_E2E_SERVER_PORT ?? '3107'; // Ізолюємо E2E від звичайного dev-сервера на 3000 порту.
  const clientPort = process.env.LAB7_E2E_CLIENT_PORT ?? '4177'; // Ізолюємо браузерний стенд від інших Vite вікон.
  const sharedEnvironment = {
    ...process.env,
    PORT: serverPort,
    NODE_OPTIONS: [process.env.NODE_OPTIONS, '--require=../test-preload.cjs'].filter(Boolean).join(' '),
  }; // Лише сервер тесту обходить Windows userInfo проблему та слухає окремий порт.
  const server = spawn(process.execPath, ['--env-file-if-exists=.env', '--import', 'tsx', 'src/index.ts'], {
    cwd: serverDirectory,
    env: sharedEnvironment,
    stdio: 'inherit',
  }); // Підіймаємо API й WebSocket сервер окремим керованим процесом.
  const viteEnvironment = { ...process.env, PORT: serverPort }; // Vite проксуватиме API до сервера цього E2E запуску.
  const vite = spawn(
    process.execPath,
    ['../node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', clientPort, '--strictPort'],
    { cwd: clientDirectory, env: viteEnvironment, stdio: 'inherit' },
  ); // Підіймаємо Vite напряму на окремому тестовому порту.
  try {
    await Promise.all([
      waitForReady('http://127.0.0.1:' + serverPort + '/health', server, 'Node server'),
      waitForReady('http://127.0.0.1:' + clientPort, vite, 'Vite client'),
    ]); // Чекаємо на обидві частини застосунку.
  } catch (error: unknown) {
    await Promise.all([stop(vite), stop(server)]); // Не лишаємо один процес, якщо другий не стартував.
    throw error; // Передаємо Playwright початкову причину проблеми запуску.
  } // Завершуємо перевірку готовності.
  return async () => {
    await Promise.all([stop(vite), stop(server)]); // Завершуємо обидва дочірні процеси після тесту.
  }; // Повертаємо global teardown callback.
} // Завершуємо підготовку E2E середовища.
