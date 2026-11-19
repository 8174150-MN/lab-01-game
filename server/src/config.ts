// Конфігурація сервера перевіряється в runtime до запуску HTTP чи WebSocket.
import path from 'node:path';
import { z } from 'zod';

// Текстові змінні середовища перетворюємо на числа та перевіряємо їхні межі.
const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.preprocess(
    (value: unknown) => (typeof value === 'string' && value.trim() !== '' ? Number(value) : value),
    z.number().int().min(0).max(65535).default(3000),
  ),
  HOST: z
    .string()
    .trim()
    .min(1)
    .default('0.0.0.0')
    .refine((value) => !value.includes(' '), 'HOST cannot contain spaces'),
  LOG_DIR: z
    .string()
    .trim()
    .min(1)
    .default('./logs')
    .refine((value) => !value.includes('\0'), 'LOG_DIR cannot contain a null byte'),
  MAX_BODY_BYTES: z.preprocess(
    (value: unknown) => (typeof value === 'string' && value.trim() !== '' ? Number(value) : value),
    z.number().int().min(1024).max(1048576).default(65536),
  ),
  MAX_ROOMS: z.preprocess(
    (value: unknown) => (typeof value === 'string' && value.trim() !== '' ? Number(value) : value),
    z.number().int().min(1).max(1000).default(20),
  ),
  MAX_PLAYERS_PER_ROOM: z.preprocess(
    (value: unknown) => (typeof value === 'string' && value.trim() !== '' ? Number(value) : value),
    z.number().int().min(1).max(100).default(10),
  ),
  MAX_MESSAGE_BYTES: z.preprocess(
    (value: unknown) => (typeof value === 'string' && value.trim() !== '' ? Number(value) : value),
    z.number().int().min(64).max(65536).default(2048),
  ),
  MAX_MESSAGES_PER_SECOND: z.preprocess(
    (value: unknown) => (typeof value === 'string' && value.trim() !== '' ? Number(value) : value),
    z.number().int().min(1).max(1000).default(120),
  ),
  ENABLE_DEMOS: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
  // Зберігаємо список дозволених сайтів як origin-значення без шляхів і query.
  ALLOWED_ORIGINS: z
    .string()
    .default(
      'http://localhost:3000,http://127.0.0.1:3000,http://localhost:5173,http://127.0.0.1:5173,http://localhost:4177,http://127.0.0.1:4177',
    )
    .transform((value) =>
      value
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean),
    )
    .refine(
      (origins) =>
        origins.every((origin) => {
          try {
            const parsed = new URL(origin);
            return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.origin === origin;
          } catch {
            return false;
          }
        }),
      'ALLOWED_ORIGINS must be comma-separated http(s) origins without paths',
    ),
  // Обмежуємо кількість одночасних WebSocket на одну адресу.
  MAX_CONNECTIONS_PER_IP: z.preprocess(
    (value: unknown) => (typeof value === 'string' && value.trim() !== '' ? Number(value) : value),
    z.number().int().min(1).max(1000).default(20),
  ),
  // Forwarded headers довіряємо лише тоді, коли сервер стоїть за відомим проксі.
  TRUST_PROXY: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  BUILD_SHA: z.string().trim().min(1).max(64).default('dev'),
  BUILD_VERSION: z.string().trim().min(1).max(64).default('dev'),
  // Render adds its public HTTPS URL to web services at runtime.
  RENDER_EXTERNAL_URL: z
    .string()
    .trim()
    .url()
    .optional()
    .refine(
      (value) => value === undefined || (new URL(value).protocol === 'https:' && new URL(value).origin === value),
    ),
});

export type ServerEnvironment = z.infer<typeof environmentSchema>;
export interface ServerConfig extends Omit<ServerEnvironment, 'RENDER_EXTERNAL_URL'> {
  readonly DIST_DIR: string;
}

// process.env має зовнішні рядки, тому його форма проходить ту саму safeParse-межу.
const parsedEnvironment = environmentSchema.safeParse(process.env);
if (!parsedEnvironment.success) {
  const details = parsedEnvironment.error.issues.map((issue) => issue.path.join('.') + ': ' + issue.message).join('; ');
  throw new Error('Invalid server environment: ' + details);
}

// Відокремлюємо адресу Render від основної конфігурації після Zod-перевірки.
const { RENDER_EXTERNAL_URL, ...validatedEnvironment } = parsedEnvironment.data;
const allowedOrigins = new Set(validatedEnvironment.ALLOWED_ORIGINS);
if (RENDER_EXTERNAL_URL) allowedOrigins.add(RENDER_EXTERNAL_URL); // Дозволяємо браузерний сайт, виданий Render.

// Обчислюємо шляхи лише після успішної перевірки оточення.
export const config = Object.freeze({
  ...validatedEnvironment,
  ALLOWED_ORIGINS: [...allowedOrigins],
  LOG_DIR: path.resolve(validatedEnvironment.LOG_DIR),
  DIST_DIR: path.resolve(process.cwd(), 'client/dist'),
}) satisfies ServerConfig;
