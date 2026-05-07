const { logLevel } = require('../config');

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const currentLevel = LEVELS[logLevel] || LEVELS.info;

function timestamp() {
  return new Date().toISOString();
}

function log(level, ...args) {
  if (LEVELS[level] >= currentLevel) {
    console.log(`[${timestamp()}] [${level.toUpperCase()}]`, ...args);
  }
}

module.exports = {
  debug: (...args) => log('debug', ...args),
  info: (...args) => log('info', ...args),
  warn: (...args) => log('warn', ...args),
  error: (...args) => log('error', ...args),
};