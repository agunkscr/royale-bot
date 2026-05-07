// Action types
const ACTIONS = {
  MOVE: 'move',
  ATTACK: 'attack',
  PICKUP: 'pickup',
  EQUIP: 'equip',
  USE: 'use_item',
  REST: 'rest',
  TALK: 'talk',
  WHISPER: 'whisper',
  INTERACT: 'interact',
};

// Cooldown group (aksi yang butuh cooldown)
const COOLDOWN_ACTIONS = [
  ACTIONS.MOVE, ACTIONS.ATTACK, ACTIONS.USE, ACTIONS.REST, ACTIONS.INTERACT
];

// Free actions (tidak pengaruhi cooldown)
const FREE_ACTIONS = [ACTIONS.PICKUP, ACTIONS.EQUIP, ACTIONS.TALK, ACTIONS.WHISPER];

module.exports = { ACTIONS, COOLDOWN_ACTIONS, FREE_ACTIONS };