const { ACTIONS } = require('../../utils/constants');

/**
 * Memutuskan aksi berdasarkan agent_view / game state.
 * @param {Object} state - Data dari agent_view (berisi posisi, inventory, musuh terdekat, dll.)
 * @param {Object} context - Tambahan: canAct, kondisi internal
 * @returns {Object} keputusan: { type, params, reasoning }
 */
function decide(state, context = {}) {
  const me = state.agent;          // data diri
  const enemies = state.visible_agents || [];
  const monsters = state.visible_monsters || [];
  const items = state.items_nearby || [];
  const map = state.map || {};

  // 1. Jika HP rendah & ada healing item, gunakan
  if (me.hp < 50 && me.inventory) {
    const healItem = me.inventory.find(i => 
      ['Emergency Food', 'Bandage', 'Medkit'].includes(i.name)
    );
    if (healItem && context.canAct) {
      return {
        type: ACTIONS.USE,
        params: { item_id: healItem.id },
        reasoning: 'HP rendah, menggunakan item healing',
      };
    }
  }

  // 2. Jika ada monster di dekat dan HP > 30, serang
  if (monsters.length > 0 && me.hp > 30 && context.canAct) {
    const target = monsters[0];
    return {
      type: ACTIONS.ATTACK,
      params: { target_id: target.id },
      reasoning: `Menyerang monster ${target.id}`,
    };
  }

  // 3. Jika ada item tergeletak (pickup bebas cooldown)
  if (items.length > 0) {
    const item = items[0];
    return {
      type: ACTIONS.PICKUP,
      params: { item_id: item.id },
      reasoning: `Mengambil item ${item.id}`,
    };
  }

  // 4. Bergerak ke arah pusat atau acak
  if (context.canAct) {
    const direction = ['north', 'south', 'east', 'west'][Math.floor(Math.random() * 4)];
    return {
      type: ACTIONS.MOVE,
      params: { direction },
      reasoning: 'Menjelajah',
    };
  }

  // 5. Jika tidak bisa aksi cooldown, diam (atau kirim free action)
  return {
    type: ACTIONS.WHISPER,
    params: { target_id: null, message: '...' },
    reasoning: 'Menunggu cooldown',
  };
}

module.exports = { decide };