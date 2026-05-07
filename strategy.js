// ═══════════════════════════════════════════════════════════════════
// strategy.js — Molty Royale Bot v3.1
//   Output format disesuaikan dengan docs resmi:
//   { action, data, reason }  ← di-wrap oleh index.js menjadi
//   { type:'action', data:{type, ...}, thought:{reasoning, plannedAction} }
//
//   Perubahan dari v3.0:
//   - canAct sekarang direspek juga untuk free actions (equip/pickup/talk)
//     yang memang bebas cooldown per docs
//   - 'explore' action TIDAK dikirim (disabled per docs)
//   - drop_item bukan aksi resmi — diganti dengan tidak pickup jika penuh
//     (inventory max 10, server yang mengelola)
// ═══════════════════════════════════════════════════════════════════

import { getBestSmoltzRegion } from './smoltz-optimizer.js';

/* ── Weapon stats ──────────────────────────────────────────────── */
const WEAPONS = {
  fist:   { bonus: 0,  range: 0 },
  dagger: { bonus: 10, range: 0 },
  sword:  { bonus: 20, range: 0 },
  katana: { bonus: 35, range: 0 },
  bow:    { bonus: 5,  range: 1 },
  pistol: { bonus: 10, range: 1 },
  sniper: { bonus: 28, range: 2 },
};

/* ── Item priority ─────────────────────────────────────────────── */
const ITEM_PRIORITY = {
  katana: 100, sniper: 95, sword: 90, pistol: 85,
  dagger: 80, bow: 75,
  medkit: 70, bandage: 65, emergency_food: 60, energy_drink: 58,
};

const ITEM_DROP_VALUE = {
  katana: 10, sniper: 9.5, sword: 9, pistol: 8.5,
  dagger: 8, bow: 7.5,
  medkit: 7, bandage: 6.5, emergency_food: 6, energy_drink: 5.8,
  fist: 0,
};

/* ── Recovery items ────────────────────────────────────────────── */
const RECOVERY = {
  medkit: 50, bandage: 30, emergency_food: 20,
  energy_drink: 0,
};

/* ── Weather combat penalty ────────────────────────────────────── */
const WEATHER_PENALTY = {
  clear: 0.0, rain: 0.05, fog: 0.10, storm: 0.15,
};

/* ── Global memory ─────────────────────────────────────────────── */
let gameId        = null;
let knownAgents   = {};
let combatHistory = { lastHp: 100, damageThisTick: false, lastAttackerId: '' };

/* ══════════════════════════════════════════════════════════════════
   PUBLIC API
   Mengembalikan array { action, data, reason }
   index.js yang akan wrap ke format resmi docs.
   ══════════════════════════════════════════════════════════════════ */

export function decideActions(msgOrView, canAct) {
  // Support both raw view object dan message envelope dari server
  const view = msgOrView.view || msgOrView;
  resetIfNewGame(view);
  const actions = [];

  // 1. Free actions — pickup & equip (tidak butuh canAct, bebas cooldown per docs)
  actions.push(...buildFreeActions(view));

  // 2. Main action — butuh canAct untuk aksi dengan cooldown
  const main = decideMainAction(view, canAct);
  if (main) actions.push(main);

  return actions;
}

/* ══════════════════════════════════════════════════════════════════
   FREE ACTIONS: pickup → equip
   Per docs: pickup & equip bebas cooldown, bisa dikirim kapan saja
   CATATAN: drop_item bukan aksi resmi di docs — dihapus
   ══════════════════════════════════════════════════════════════════ */

function buildFreeActions(view) {
  const actions  = [];
  const self     = view.self || {};
  const inv      = self.inventory || [];
  const regionId = (view.currentRegion || {}).id || '';

  // Pickup item terbaik yang tersedia
  const visibleItems = unwrapItems(view.visibleItems || []);
  const localItems   = visibleItems.filter(i => i.regionId === regionId && i.id);

  if (localItems.length) {
    localItems.sort((a, b) => pickupScore(b, inv) - pickupScore(a, inv));
    const best = localItems[0];
    // Hanya pickup jika inventory belum penuh ATAU item ini lebih baik dari yg terburuk
    if (pickupScore(best, inv) > 0 && inv.length < 10) {
      actions.push({ action: 'pickup', data: { itemId: best.id }, reason: 'FREE PICKUP' });
    }
  }

  // Equip senjata terbaik dari inventory
  const equipped    = self.equippedWeapon;
  const currentBonus = getWeaponBonus(equipped);
  let bestWpn = null, bestBonus = currentBonus;
  for (const item of inv) {
    if (item.category === 'weapon') {
      const bonus = getWeaponBonus(item);
      if (bonus > bestBonus) { bestWpn = item; bestBonus = bonus; }
    }
  }
  if (bestWpn)
    actions.push({ action: 'equip', data: { itemId: bestWpn.id }, reason: 'FREE EQUIP' });

  return actions;
}

/* ══════════════════════════════════════════════════════════════════
   MAIN ACTION — semua aksi ini punya cooldown 60s
   Hanya dikirim jika canAct = true
   ══════════════════════════════════════════════════════════════════ */

function decideMainAction(view, canAct) {
  const self       = view.self || {};
  const region     = view.currentRegion || {};
  const hp         = self.hp      ?? 100;
  const ep         = self.ep      ?? 10;
  const atk        = self.atk     ?? 10;
  const def        = self.def     ?? 5;
  const isAlive    = self.isAlive ?? true;
  const inv        = self.inventory || [];
  const equipped   = self.equippedWeapon;
  const myId       = self.id || '';

  const visibleAgents   = view.visibleAgents   || [];
  const visibleMonsters = view.visibleMonsters  || [];
  const connections     = view.connectedRegions || region.connections || [];
  const pendingDZ       = view.pendingDeathzones || [];
  const regionId        = region.id || '';
  const terrain         = (region.terrain || '').toLowerCase();
  const weather         = (region.weather  || '').toLowerCase();

  if (!isAlive) return null;

  const dangerIds = new Set();
  for (const dz of pendingDZ) dangerIds.add(typeof dz === 'string' ? dz : dz.id);
  for (const conn of connections) {
    const r = resolveRegion(conn, view);
    if (r?.isDeathZone) dangerIds.add(r.id);
  }

  trackAgents(visibleAgents, myId, regionId);
  updateCombatHistory(hp, view.recentMessages || view.recentLogs || [], myId);

  const moveEpCost    = getMoveEpCost(terrain, weather);
  const enemies       = visibleAgents.filter(a => !a.isGuardian && a.isAlive && a.id !== myId);
  const guardiansHere = visibleAgents.filter(a => a.isGuardian && a.isAlive && a.regionId === regionId);

  // ── 1. Death zone escape (tidak butuh canAct — pindah dulu) ──────
  if (region.isDeathZone || dangerIds.has(regionId)) {
    const safe = findSafeRegion(connections, dangerIds, view);
    if (safe && ep >= moveEpCost)
      return { action: 'move', data: { regionId: safe }, reason: 'DZ ESCAPE' };
  }

  // ── 2. Desperate flee ───────────────────────────────────────────
  const hasHealing = inv.some(i => RECOVERY[(i.typeId || '').toLowerCase()] > 0);
  if (hp < 20 && !hasHealing && (enemies.length || guardiansHere.length)) {
    const safe = findSafeRegion(connections, dangerIds, view);
    if (safe && ep >= moveEpCost)
      return { action: 'move', data: { regionId: safe }, reason: 'DESPERATE FLEE' };
  }

  // ── 3. Counter-attack (jika canAct) ─────────────────────────────
  if (canAct && combatHistory.damageThisTick) {
    const attacker = findAttacker(combatHistory.lastAttackerId, visibleAgents);
    if (attacker) {
      const range = getWeaponRange(equipped);
      if (isInRange(attacker, regionId, range, connections)) {
        combatHistory.damageThisTick = false;
        return { action: 'attack', data: { targetId: attacker.id, targetType: 'agent' }, reason: 'COUNTER-ATTACK' };
      } else {
        const move = moveTowardTarget(attacker, connections, dangerIds, view);
        if (move && ep >= moveEpCost) {
          combatHistory.damageThisTick = false;
          return { action: 'move', data: { regionId: move }, reason: 'CHASE ATTACKER' };
        }
      }
    }
  }

  // ── 4. Guardian evasion ─────────────────────────────────────────
  if (guardiansHere.length && ep >= moveEpCost) {
    const threat = guardiansHere.reduce((max, g) => (g.atk || 10) > (max.atk || 10) ? g : max);
    const gDmg   = calcDamage(threat.atk || 10, estimateWeaponBonus(threat), def, weather);
    if (hp < Math.max(35, Math.floor(gDmg * 1.5))) {
      const safe = findSafeRegion(connections, dangerIds, view);
      if (safe)
        return { action: 'move', data: { regionId: safe }, reason: 'GUARDIAN FLEE' };
    }
  }

  // Semua aksi di bawah butuh canAct (cooldown group)
  if (!canAct) return null;

  // ── 5. Healing ──────────────────────────────────────────────────
  if (hp < 30) {
    const heal = findHealing(inv);
    if (heal)
      return { action: 'use_item', data: { itemId: heal.id }, reason: 'HEAL' };
  }

  // ── 6. Combat: Guardian farming ─────────────────────────────────
  const guardians = visibleAgents.filter(a => a.isGuardian && a.isAlive);
  if (guardians.length && ep >= 2 && hp >= 30) {
    const target = selectBestTarget(guardians, atk, equipped, def, weather);
    if (isInRange(target, regionId, getWeaponRange(equipped), connections))
      return { action: 'attack', data: { targetId: target.id, targetType: 'agent' }, reason: 'GUARDIAN FARM' };
    const move = moveTowardTarget(target, connections, dangerIds, view);
    if (move && ep >= moveEpCost && hp >= 40)
      return { action: 'move', data: { regionId: move }, reason: 'APPROACH GUARDIAN' };
  }

  // ── 7. Combat: Agent ────────────────────────────────────────────
  if (enemies.length && ep >= 2 && hp >= 30) {
    const target = selectBestTarget(enemies, atk, equipped, def, weather);
    if (isInRange(target, regionId, getWeaponRange(equipped), connections)) {
      const myDmg = calcDamage(atk, getWeaponBonus(equipped), target.def || 5, weather);
      const eDmg  = calcDamage(target.atk || 10, estimateWeaponBonus(target), def, weather);
      if (myDmg > eDmg || (target.hp || 100) <= myDmg * 2)
        return { action: 'attack', data: { targetId: target.id, targetType: 'agent' }, reason: 'COMBAT' };
    } else {
      const move = moveTowardTarget(target, connections, dangerIds, view);
      if (move && ep >= moveEpCost)
        return { action: 'move', data: { regionId: move }, reason: 'CHASE' };
    }
  }

  // ── 8. Monster farming ──────────────────────────────────────────
  const monsters = visibleMonsters.filter(m => m.hp > 0);
  if (monsters.length && ep >= 2 && hp >= 25) {
    const target = selectBestTarget(monsters, atk, equipped, def, weather);
    if (isInRange(target, regionId, getWeaponRange(equipped), connections))
      return { action: 'attack', data: { targetId: target.id, targetType: 'monster' }, reason: 'MONSTER FARM' };
  }

  // ── 9. sMoltz hunt ──────────────────────────────────────────────
  if (ep >= moveEpCost && connections.length) {
    const smoltzTarget = getBestSmoltzRegion(connections, dangerIds, view, inv);
    if (smoltzTarget)
      return { action: 'move', data: { regionId: smoltzTarget }, reason: 'SMOLTZ HUNT' };
  }

  // ── 10. Explore (move ke region terbaik) ────────────────────────
  // CATATAN: 'explore' action per docs sudah DISABLED — kita pakai 'move' saja
  if (ep >= moveEpCost && connections.length) {
    const target = chooseMoveTarget(connections, dangerIds, region, enemies);
    if (target)
      return { action: 'move', data: { regionId: target }, reason: 'EXPLORE' };
  }

  // ── 11. Rest ────────────────────────────────────────────────────
  if (ep < 3 && !enemies.length && !guardiansHere.length
      && !region.isDeathZone && !dangerIds.has(regionId))
    return { action: 'rest', data: {}, reason: 'REST' };

  return null;
}

/* ══════════════════════════════════════════════════════════════════
   WORLD MODEL HELPERS
   ══════════════════════════════════════════════════════════════════ */

function getMoveEpCost(terrain, weather) {
  return (terrain === 'water' || weather === 'storm') ? 3 : 2;
}

function resolveRegion(entry, view) {
  if (typeof entry === 'object') return entry;
  if (typeof entry === 'string')
    return (view.visibleRegions || []).find(r => r.id === entry) || null;
  return null;
}

function findSafeRegion(connections, dangerIds, view) {
  for (const conn of connections) {
    const rid      = typeof conn === 'string' ? conn : conn.id;
    const resolved = typeof conn === 'object' ? conn : resolveRegion(conn, view);
    if (rid && !dangerIds.has(rid) && !resolved?.isDeathZone) return rid;
  }
  return null;
}

function isInRange(target, myRegion, weaponRange, connections) {
  const tr = target?.regionId;
  if (!tr || tr === myRegion) return true;
  if (weaponRange >= 1 && connections) {
    const adj = new Set(connections.map(c => typeof c === 'string' ? c : c.id));
    return adj.has(tr);
  }
  return false;
}

function moveTowardTarget(target, connections, dangerIds, view) {
  const tr = target?.regionId;
  if (!tr) return null;
  for (const conn of connections) {
    const rid = typeof conn === 'string' ? conn : conn.id;
    if (rid === tr && !dangerIds.has(rid) && !(typeof conn === 'object' && conn.isDeathZone))
      return rid;
  }
  return findSafeRegion(connections, dangerIds, view);
}

function chooseMoveTarget(connections, dangerIds, region, enemies) {
  const enemyRegions = new Set((enemies || []).map(e => e.regionId));
  const candidates   = [];
  for (const conn of connections) {
    const rid      = typeof conn === 'string' ? conn : conn.id;
    const resolved = typeof conn === 'object' ? conn : null;
    if (!rid || dangerIds.has(rid) || resolved?.isDeathZone) continue;
    let score = 1;
    if (resolved) {
      const t = (resolved.terrain || '').toLowerCase();
      const w = (resolved.weather || '').toLowerCase();
      score += { hills: 4, plains: 2, ruins: 2, forest: 1, water: -3 }[t] || 0;
      score += { clear: 1, rain: 0, fog: -1, storm: -2 }[w] || 0;
    }
    if (enemyRegions.has(rid)) score += 3;
    candidates.push({ rid, score });
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0]?.rid || null;
}

/* ══════════════════════════════════════════════════════════════════
   INVENTORY MANAGEMENT
   ══════════════════════════════════════════════════════════════════ */

function unwrapItems(raw) {
  const out = [];
  for (const entry of (raw || [])) {
    if (!entry || typeof entry !== 'object') continue;
    const inner = entry.item || entry;
    if (inner && typeof inner === 'object') {
      inner.regionId = entry.regionId || inner.regionId || '';
      out.push(inner);
    }
  }
  return out;
}

function pickupScore(item, inventory) {
  const typeId = (item.typeId || '').toLowerCase();
  if (typeId === 'rewards' || item.category === 'currency') return 1000;
  if (item.category === 'weapon') {
    const bonus       = getWeaponBonus(item);
    const currentBest = Math.max(0, ...inventory.filter(i => i.category === 'weapon').map(i => getWeaponBonus(i)));
    return bonus > currentBest ? 100 + bonus : 0;
  }
  return ITEM_PRIORITY[typeId] || 0;
}

function findHealing(inventory) {
  const heals = inventory.filter(i => RECOVERY[(i.typeId || '').toLowerCase()] > 0);
  heals.sort((a, b) => (RECOVERY[(b.typeId || '').toLowerCase()] || 0) - (RECOVERY[(a.typeId || '').toLowerCase()] || 0));
  return heals[0] || null;
}

/* ══════════════════════════════════════════════════════════════════
   COMBAT
   ══════════════════════════════════════════════════════════════════ */

function calcDamage(atk, weaponBonus, def, weather) {
  const base    = atk + weaponBonus - Math.floor(def * 0.5);
  const penalty = WEATHER_PENALTY[weather] || 0;
  return Math.max(1, Math.floor(base * (1 - penalty)));
}

function getWeaponBonus(item) {
  if (!item) return 0;
  const typeId = (item.typeId || '').toLowerCase();
  return WEAPONS[typeId]?.bonus || 0;
}

function getWeaponRange(item) {
  if (!item) return 0;
  const typeId = (item.typeId || '').toLowerCase();
  return WEAPONS[typeId]?.range || 0;
}

function estimateWeaponBonus(agent) {
  const weapon = agent?.equippedWeapon;
  if (!weapon) return 0;
  const typeId = (typeof weapon === 'string' ? weapon : weapon.typeId || '').toLowerCase();
  return WEAPONS[typeId]?.bonus || 0;
}

function selectBestTarget(targets, myAtk, equipped, myDef, weather) {
  let best = null, bestScore = -Infinity;
  const myBonus = getWeaponBonus(equipped);
  for (const t of targets) {
    const tHp     = Math.max(t.hp || 100, 1);
    const myDmg   = calcDamage(myAtk, myBonus, t.def || 5, weather);
    const theirDmg = calcDamage(t.atk || 10, estimateWeaponBonus(t), myDef, weather);
    const score   = (myDmg / tHp) * 100 - theirDmg * 0.5;
    if (score > bestScore) { bestScore = score; best = t; }
  }
  return best || targets[0];
}

function findAttacker(attackerId, visibleAgents) {
  if (!attackerId || attackerId === 'unknown') return null;
  return visibleAgents.find(a => a.id === attackerId && a.isAlive) || null;
}

/* ══════════════════════════════════════════════════════════════════
   MEMORY & TRACKING
   ══════════════════════════════════════════════════════════════════ */

function resetIfNewGame(view) {
  const newId = view.gameId || '';
  if (newId && newId !== gameId) {
    gameId        = newId;
    knownAgents   = {};
    combatHistory = { lastHp: 100, damageThisTick: false, lastAttackerId: '' };
  }
}

function trackAgents(agents, myId, myRegion) {
  for (const a of agents) {
    if (!a.id || a.id === myId) continue;
    knownAgents[a.id] = {
      hp: a.hp, atk: a.atk, def: a.def,
      isGuardian: a.isGuardian, equippedWeapon: a.equippedWeapon,
      lastSeen: myRegion, isAlive: a.isAlive,
    };
  }
}

function updateCombatHistory(currentHp, logs, myId) {
  const last = combatHistory.lastHp ?? currentHp;
  if (currentHp < last) {
    combatHistory.damageThisTick = true;
    for (const entry of logs) {
      if ((entry.message || '').toLowerCase().includes('damage')) {
        const aid = entry.attackerId || entry.sourceId || '';
        const tid = entry.targetId   || '';
        if (tid === myId && aid && aid !== myId) {
          combatHistory.lastAttackerId = aid;
          combatHistory.lastHp = currentHp;
          return;
        }
      }
    }
    combatHistory.lastAttackerId = 'unknown';
  } else {
    combatHistory.damageThisTick = false;
  }
  combatHistory.lastHp = currentHp;
}
