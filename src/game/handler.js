const DecisionMaker = require('./decider');
const logger = require('../utils/logger');

class GameHandler {
  constructor(sendFn) {
    this.decider = new DecisionMaker();
    this.send = sendFn;            // fungsi untuk kirim JSON ke WS
    this.turnTimer = null;
    this.gameOver = false;
  }

  handleMessage(rawMsg) {
    if (this.gameOver) return;

    try {
      const msg = JSON.parse(rawMsg);
      switch (msg.type) {
        case 'agent_view':
        case 'turn_advanced':
          this.onTurn(msg.data);
          break;
        case 'action_result':
          this.onActionResult(msg.data);
          break;
        case 'event':
          this.onEvent(msg.data);
          break;
        case 'error':
          logger.error('Server error:', msg.message);
          break;
        // welcome, assigned, joined, etc. should be handled by the join flow,
        // but if they appear here (reconnect), just log.
        default:
          logger.debug('Unhandled message type:', msg.type);
      }
    } catch (e) {
      logger.error('Error parsing message:', e);
    }
  }

  onTurn(gameState) {
    // Hapus timer sebelumnya
    if (this.turnTimer) clearTimeout(this.turnTimer);

    const decision = this.decider.getDecision(gameState);
    if (decision) {
      const payload = this.decider.buildActionPayload(decision);
      this.send(payload);
      logger.debug('Action sent:', decision.type);
    } else {
      logger.debug('No decision, skip turn');
    }

    // Safety: jika belum kirim aksi dalam 55 detik, kirim rest (hanya jika canAct true)
    this.turnTimer = setTimeout(() => {
      if (this.decider.canAct) {
        const restDecision = {
          type: 'rest',
          reasoning: 'Turn timeout safety rest',
        };
        this.send(this.decider.buildActionPayload(restDecision));
        logger.warn('Turn timeout, forced rest');
      }
    }, 55000);
  }

  onActionResult(result) {
    this.decider.updateCanAct(result.canAct);
    if (!result.canAct) {
      logger.info(`Cooldown aktif, sisa ${result.cooldownRemainingMs}ms`);
    }
  }

  onEvent(eventData) {
    // Log event penting (player kill, dll.)
    if (eventData.type === 'player_kill') {
      logger.info(`Player killed: ${eventData.killer} killed ${eventData.victim}`);
    }
  }

  cleanup() {
    if (this.turnTimer) clearTimeout(this.turnTimer);
    this.gameOver = true;
  }
}

module.exports = GameHandler;