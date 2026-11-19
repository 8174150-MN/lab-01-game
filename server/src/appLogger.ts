// Pino writes operational events as structured JSON lines to stdout for the host to collect.
import pino from 'pino'; // Pino keeps log records structured and supports a configurable level.
import { config } from './config.js'; // The validated environment supplies log level and build identity.

// Shared fields identify the running application without exposing secrets.
export const logger = pino({
  level: config.LOG_LEVEL, // Apply LOG_LEVEL after the environment has passed Zod validation.
  base: { service: 'asteroids-game', version: config.BUILD_VERSION, gitSha: config.BUILD_SHA }, // Stamp every log with its build.
  timestamp: pino.stdTimeFunctions.isoTime, // Keep timestamps readable and machine-parseable.
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.headers.x-api-key',
      'password',
      'token',
      'secret',
      'apiKey',
      'accessToken',
      'refreshToken',
      '*.password',
      '*.token',
      '*.secret',
      '*.apiKey',
    ],
    censor: '[REDACTED]',
  }, // Hide common credentials even if a future log adds a request-like object.
});
