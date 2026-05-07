import { decideActions } from './strategies/default.js';
import { COOLDOWN_ACTIONS } from '../utils/constants.js';
import { logger } from '../utils/logger.js';

export class DecisionMaker {
  constructor() {
    this.canAct = true;
  }

  updateCanAct(canAct) {
    this.canAct = canAct;
  }

  getDecisions(gameState) {
    const decisions = decideActions(gameState, this.canAct);
    return decisions.map(d => ({
      type: 'action',
      data: d.data ? { type: d.type, ...d.data } : { type: d.type },
      thought: {
        reasoning: `Aksi ${d.type}`,
        plannedAction: d.type,
      },
    }));
  }
}