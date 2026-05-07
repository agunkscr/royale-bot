const { decide } = require('./strategies/default');
const { COOLDOWN_ACTIONS } = require('../utils/constants');
const logger = require('../utils/logger');

class DecisionMaker {
  constructor() {
    this.canAct = true;   // akan diupdate oleh action_result
    this.context = {};
  }

  updateCanAct(canAct) {
    this.canAct = canAct;
  }

  /**
   * Memutuskan aksi untuk dikirim.
   * @param {Object} gameState - dari agent_view
   * @returns {Object|null} - payload action, atau null jika tidak kirim apa-apa
   */
  getDecision(gameState) {
    // Beri tahu strategi apakah aksi cooldown diizinkan
    const context = {
      canAct: this.canAct,
    };

    const decision = decide(gameState, context);
    if (!decision) return null;

    // Jika aksi yang dipilih cooldown tapi canAct=false, ganti ke free action (whisper kosong)
    if (COOLDOWN_ACTIONS.includes(decision.type) && !this.canAct) {
      logger.debug('Cooldown masih aktif, ganti ke whispered silence');
      return {
        type: 'whisper',
        params: { target_id: null, message: '' },
        reasoning: 'Menunggu cooldown',
      };
    }

    return decision;
  }

  buildActionPayload(decision) {
    return {
      type: 'action',
      data: {
        type: decision.type,
        ...decision.params,
      },
      thought: {
        reasoning: decision.reasoning,
        plannedAction: decision.type,
      },
    };
  }
}

module.exports = DecisionMaker;