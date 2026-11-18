// Конфігурація сервера перевіряється в runtime до запуску HTTP чи WebSocket.
import path from 'node:path';
import { z } from 'zod';

// Текстові змінні середовища перетворюємо на числа та перевіряємо їхні межі.
const environmentSchema = z.object({
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
});

export type ServerEnvironment = z.infer<typeof environmentSchema>;
export interface ServerConfig extends ServerEnvironment {
  readonly DIST_DIR: string;
}

// process.env має зовнішні рядки, тому його форма проходить ту саму safeParse-межу.
const parsedEnvironment = environmentSchema.safeParse(process.env);
if (!parsedEnvironment.success) {
  const details = parsedEnvironment.error.issues.map((issue) => issue.path.join('.') + ': ' + issue.message).join('; ');
  throw new Error('Invalid server environment: ' + details);
}

// Обчислюємо шляхи лише після успішної перевірки оточення.
export const config = Object.freeze({
  ...parsedEnvironment.data,
  LOG_DIR: path.resolve(parsedEnvironment.data.LOG_DIR),
  DIST_DIR: path.resolve(import.meta.dirname, '../../client/dist'),
}) satisfies ServerConfig;
