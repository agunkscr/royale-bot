import { DecisionMaker } from './decider.js';
import { logger } from '../utils/logger.js';
import dashboardState from '../utils/state-bridge.js';

export class GameHandler {
  constructor(sendFn) {
    this.send = sendFn;
    this.decider = new DecisionMaker();
    this.turnTimer = null;
    this.gameOver = false;
  }

  handleMessage(raw) {
    if (this.gameOver) return;
    try {
      const msg = JSON.parse(raw);
      switch (msg.type) {
        case 'agent_view':
        case 'turn_advanced':
          this.onTurn(msg.data || msg);
          break;
        case 'action_result':
          this.decider.updateCanAct(msg.data?.canAct ?? msg.canAct ?? true);
          break;
        case 'event':
          logger.info('Event:', msg.data?.type);
          break;
        case 'game_ended':
          this.gameOver = true;
          dashboardState.addLog('primary', `Game ended. Winner: ${msg.winnerId}`);
          if (this.turnTimer) clearTimeout(this.turnTimer);
          break;
        case 'error':
          logger.error('Game error:', msg.message);
          break;
      }
    } catch (e) {
      logger.error('Handler error:', e);
    }
  }

  onTurn(gameState) {
    if (this.turnTimer) clearTimeout(this.turnTimer);

    const agent = gameState.agent;
    if (agent) {
      dashboardState.updateAgent('primary', {
        name: 'BotAgent',
        hp: agent.hp,
        ep: agent.ep,
        status: agent.isAlive ? 'alive' : 'dead',
        rewards: agent.rewards || {},
      });
    }

    const payloads = this.decider.getDecisions(gameState);
    payloads.forEach(p => this.send(p));
    logger.debug(`Sent ${payloads.length} actions`);

    this.turnTimer = setTimeout(() => {
      if (this.decider.canAct) {
        this.send({
          type: 'action',
          data: { type: 'rest' },
          thought: { reasoning: 'Safety rest', plannedAction: 'rest' },
        });
        logger.warn('Forced rest due to timeout');
      }
    }, 55000);
  }

  cleanup() {
    if (this.turnTimer) clearTimeout(this.turnTimer);
  }
}