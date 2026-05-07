const AgentLoop = require('./core/agent-loop');
const logger = require('./utils/logger');

const loop = new AgentLoop();
loop.start();

// Tangani graceful shutdown
process.on('SIGINT', () => {
  logger.info('Menghentikan bot...');
  loop.stop();
  process.exit(0);
});

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled Rejection:', reason);
});