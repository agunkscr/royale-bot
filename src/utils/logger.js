import { config } from '../config.js';

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const currentLevel = LEVELS[config.logLevel] || LEVELS.info;

function ts() {
  return new Date().toISOString();
}

export const logger = {
  debug: (...args) => currentLevel <= 0 && console.log(`[${ts()}] [DEBUG]`, ...args),
  info: (...args) => currentLevel <= 1 && console.log(`[${ts()}] [INFO]`, ...args),
  warn: (...args) => currentLevel <= 2 && console.warn(`[${ts()}] [WARN]`, ...args),
  error: (...args) => currentLevel <= 3 && console.error(`[${ts()}] [ERROR]`, ...args),
};