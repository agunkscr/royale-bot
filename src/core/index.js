import { AgentLoop } from './core/agent-loop.js';
import { startDashboard } from '../dashboard-server.js';
import { logger } from './utils/logger.js';
import dashboardState from './utils/state-bridge.js';
import { config } from './config.js';

const loop = new AgentLoop();

process.on('SIGINT', () => {
  logger.info('Shutting down...');
  loop.stop();
  process.exit(0);
});

const port = config.port;
startDashboard(port);

dashboardState.addLog('system', 'Bot started');
logger.info(`Dashboard running on port ${port}`);

loop.start();