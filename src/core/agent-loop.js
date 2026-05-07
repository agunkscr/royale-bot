import { getAccount, registerIdentity, fetchVersion } from '../api/client.js';
import { determineState } from './state-machine.js';
import { WebSocketManager } from './websocket.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import dashboardState from '../utils/state-bridge.js';

export class AgentLoop {
  constructor() {
    this.wsm = new WebSocketManager();
    this.interval = null;
  }

  async start() {
    logger.info('Agent loop starting...');
    await fetchVersion();
    this._tick();
    this.interval = setInterval(() => this._tick(), config.pollIntervalMs);
  }

  stop() {
    if (this.interval) clearInterval(this.interval);
    this.wsm.disconnect();
  }

  async _tick() {
    try {
      const account = await getAccount();
      if (!account) return;

      const { state, action, game } = determineState(account);
      logger.info(`State: ${state} | Action: ${action}`);

      if (account.stats) {
        dashboardState.updateAgent('global', {
          totalWins: account.stats.totalWins || 0,
          totalMoltz: account.stats.moltz || 0,
          totalSmoltz: account.stats.smoltz || 0,
        });
      }

      switch (state) {
        case 'NO_IDENTITY':
          if (config.erc8004TokenId) {
            await registerIdentity(config.erc8004TokenId);
          } else {
            logger.error('NO_IDENTITY but ERC8004_TOKEN_ID not set');
          }
          break;

        case 'READY_FREE':
          if (!this.wsm.isActive() || this.wsm.currentRole !== 'game') {
            this.wsm.connectJoin('free');
          }
          break;

        case 'READY_PAID':
          if (!this.wsm.isActive() || this.wsm.currentRole !== 'game') {
            this.wsm.connectJoin('paid');
          }
          break;

        case 'IN_GAME':
          if (!this.wsm.isActive()) {
            this.wsm.connectGame();
          }
          break;

        case 'ERROR':
          logger.error('Error state, will retry');
          break;
      }
    } catch (e) {
      logger.error('Loop error:', e);
    }
  }
}