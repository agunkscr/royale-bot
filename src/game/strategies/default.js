import { ACTIONS } from '../../utils/constants.js';

export function decideActions(view, canAct) {
  const agent = view.agent;
  if (!agent || !agent.isAlive) return [];

  const region = view.region || {};
  const connections = region.connections || [];
  const enemies = (view.visible_agents || []).filter(a => !a.isGuardian && a.isAlive && a.id !== agent.id);
  const guardians = (view.visible_agents || []).filter(a => a.isGuardian && a.isAlive);
  const monsters = view.visible_monsters || [];
  const items = (view.visible_items || []).map(i => i.item || i).filter(Boolean);

  const hp = agent.hp ?? 100;
  const ep = agent.ep ?? 10;
  const inventory = agent.inventory || [];
  const weapon = agent.equippedWeapon;

  const dangerIds = new Set();
  if (region.isDeathZone) dangerIds.add(region.id);

  const moveEpCost = (region.terrain === 'water' || region.weather === 'storm') ? 3 : 2;
  const actions = [];

  // Free actions: pickup, equip
  if (items.length) {
    const best = items.reduce((a, b) => (priority(b) > priority(a) ? b : a));
    if (priority(best) > 0) actions.push({ type: ACTIONS.PICKUP, data: { itemId: best.id } });
  }
  const bestWeapon = findBestWeapon(inventory);
  if (bestWeapon && bestWeapon.id !== weapon?.id) {
    actions.push({ type: ACTIONS.EQUIP, data: { itemId: bestWeapon.id } });
  }

  if (!canAct) return actions;

  // Healing
  if (hp < 30) {
    const heal = inventory.find(i => ['medkit','bandage','emergency_food'].includes(i.type));
    if (heal) {
      actions.push({ type: ACTIONS.USE, data: { itemId: heal.id } });
      return actions;
    }
  }

  // Escape deathzone
  if (dangerIds.has(region.id)) {
    const safe = connections.find(c => !dangerIds.has(c));
    if (safe && ep >= moveEpCost) {
      actions.push({ type: ACTIONS.MOVE, data: { regionId: safe } });
      return actions;
    }
  }

  // Attack guardian
  if (guardians.length && hp > 35 && ep >= 2) {
    actions.push({ type: ACTIONS.ATTACK, data: { targetId: guardians[0].id, targetType: 'agent' } });
    return actions;
  }

  // Attack enemy
  if (enemies.length && hp > 30 && ep >= 2) {
    actions.push({ type: ACTIONS.ATTACK, data: { targetId: enemies[0].id, targetType: 'agent' } });
    return actions;
  }

  // Attack monster
  if (monsters.length && hp > 25 && ep >= 2) {
    actions.push({ type: ACTIONS.ATTACK, data: { targetId: monsters[0].id, targetType: 'monster' } });
    return actions;
  }

  // Explore
  if (connections.length && ep >= moveEpCost) {
    const target = connections[Math.floor(Math.random() * connections.length)];
    actions.push({ type: ACTIONS.MOVE, data: { regionId: target } });
    return actions;
  }

  // Rest
  if (ep < 3 && !enemies.length && !guardians.length) {
    actions.push({ type: ACTIONS.REST, data: {} });
  }

  return actions;
}

function priority(item) {
  const map = { katana:10, sniper:9, sword:8, medkit:7, bandage:6, emergency_food:5, energy_drink:4, pistol:8, dagger:7, bow:6 };
  return map[item.type] ?? 0;
}

function findBestWeapon(inv) {
  const weapons = inv.filter(i => ['katana','sniper','sword','pistol','dagger','bow'].includes(i.type));
  weapons.sort((a,b) => priority(b) - priority(a));
  return weapons[0] || null;
}