import 'dotenv/config';
import fetch from 'node-fetch';
import WebSocket from 'ws';
import { decideActions } from './strategy.js';
import dashboardState from './state-bridge.js';
import { startDashboard } from './dashboard-server.js';

const BASE = 'https://cdn.moltyroyale.com/api';
const WS_JOIN = 'wss://cdn.moltyroyale.com/ws/join';
const WS_AGENT = 'wss://cdn.moltyroyale.com/ws/agent';

let VERSION = '1.6.0';                // fallback
let HEADERS = {};
let currentAgentId = 'primary';
let gameStats = { totalWins: 0, totalMoltz: 0, totalSmoltz: 0, totalCross: 0 };

// ── Fungsi bantu ────────────────────────────────────────────────
function updateDashboardFromView(view) {
  const self = view.self || {};
  const hp = self.hp ?? 100;
  const ep = self.ep ?? 10;
  const status = self.isAlive ? 'alive' : 'dead';
  const rewards = {
    sMoltz: self.rewards?.sMoltz || 0,
    Moltz: self.rewards?.Moltz || 0,
  };
  dashboardState.updateAgent(currentAgentId, {
    name: 'BotAgent',
    hp, ep, status, rewards,
    inventory: self.inventory || [],
  });
}

// ── Main loop ─────────────────────────────────────────────────
async function main() {
  console.log('=== Molty Royale Bot ===');
  try {
    const meRes = await fetch(`${BASE}/accounts/me`, { headers: HEADERS });
    if (!meRes.ok) {
      if (meRes.status === 401) {
        console.error('Invalid API Key');
        process.exit(1);
      }
      console.error(`/accounts/me error ${meRes.status}`);
      return delayAndRetry(60000);
    }
    const me = (await meRes.json()).data;
    console.log(`Identity: ${me.readiness.erc8004Id ? 'OK' : 'MISSING'}`);

    if (!me.readiness.erc8004Id) {
      console.error('No ERC-8004 identity. Exiting.');
      process.exit(0);
    }

    if (me.stats) {
      gameStats.totalWins = me.stats.totalWins || 0;
      gameStats.totalMoltz = me.stats.moltz || 0;
      gameStats.totalSmoltz = me.stats.smoltz || 0;
      dashboardState.updateAgent(currentAgentId, gameStats);
    }

    if (me.currentGames && me.currentGames.length > 0) {
      const game = me.currentGames[0];
      return playGameViaAgentSocket(game.gameId);
    }

    const entryType = process.env.ENTRY_TYPE || 'free';
    if (entryType === 'paid') {
      console.warn('Paid mode not implemented. Use free.');
      process.exit(0);
    } else {
      return joinFree();
    }
  } catch (error) {
    console.error('Main loop error:', error);
    delayAndRetry(10000);
  }
}

function delayAndRetry(ms) {
  setTimeout(main, ms);
}

// ── WebSocket join / gameplay ─────────────────────────────────
function joinFree() {
  const ws = new WebSocket(WS_JOIN, { headers: HEADERS });
  ws.on('open', () => console.log('/ws/join opened'));
  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.type === 'welcome') {
      ws.send(JSON.stringify({ type: 'hello', entryType: 'free' }));
    } else if (msg.type === 'game_started') {
      dashboardState.addLog(currentAgentId, `Game started: ${msg.gameId}`);
      playGameLoop(ws, msg.gameId);
    } else if (msg.type === 'error') {
      console.error('Join error:', msg.error);
      ws.close();
    }
  });
  ws.on('close', (code) => {
    console.log(`Join closed (${code})`);
    delayAndRetry(5000);
  });
  ws.on('error', (e) => console.error('WS join error:', e.message));
}

function playGameLoop(ws, gameId) {
  console.log(`Playing game ${gameId}`);
  let currentState = null;

  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.type === 'state' || msg.type === 'turn') {
      currentState = msg;
      updateDashboardFromView(msg);
    }

    if (msg.yourTurn === true || (msg.type === 'turn' && msg.playerId)) {
      if (!currentState) {
        ws.send(JSON.stringify({ type: 'action', action: 'defend' }));
        return;
      }
      const actions = decideActions(currentState, true);
      for (const action of actions) {
        ws.send(JSON.stringify(action));
      }
    } else if (msg.type === 'game_ended') {
      const rewards = msg.rewards || {};
      gameStats.totalWins += msg.isWinner ? 1 : 0;
      gameStats.totalSmoltz += rewards.sMoltz || 0;
      gameStats.totalMoltz += rewards.Moltz || 0;
      dashboardState.updateAgent(currentAgentId, gameStats);
      dashboardState.addLog(currentAgentId, `Game ended. Winner: ${msg.winnerId}`);
      ws.close();
      delayAndRetry(5000);
    }
  });

  ws.on('close', (code) => {
    console.log(`Game WS closed (${code})`);
    delayAndRetry(5000);
  });
}

function playGameViaAgentSocket(gameId) {
  const ws = new WebSocket(WS_AGENT, { headers: HEADERS });
  ws.on('open', () => playGameLoop(ws, gameId));
  ws.on('error', (e) => console.error('Agent WS error:', e.message));
}

// ── Inisialisasi & autentikasi ────────────────────────────────
async function init() {
  const rawKey = process.env.API_KEY || '';

  // 1. Coba ambil versi
  try {
    const vRes = await fetch(`${BASE}/version`, {
      headers: { 'X-Version': '1.6.0' }
    });
    if (vRes.ok) {
      const vData = await vRes.json();
      if (vData.success && vData.data?.version) {
        VERSION = vData.data.version;
        console.log(`Versi server: ${VERSION}`);
      } else {
        console.warn('Gagal parse versi, tetap pakai fallback 1.6.0');
      }
    } else if (vRes.status === 426) {
      console.error('VERSION_MISMATCH: server minta versi lebih baru.');
      process.exit(1);
    } else {
      console.warn(`/version unexpected ${vRes.status}, pakai fallback.`);
    }
  } catch (e) {
    console.warn('Gagal fetch /version, pakai fallback 1.6.0. Error:', e.message);
  }

  // 2. Uji dua metode auth
  const methods = [
    {
      name: 'mr-auth',
      headers: () => ({
        'X-Version': VERSION,
        'Content-Type': 'application/json',
        'Authorization': `mr-auth ${rawKey}`
      })
    },
    {
      name: 'x-api-key',
      headers: () => ({
        'X-Version': VERSION,
        'Content-Type': 'application/json',
        'X-API-Key': rawKey
      })
    }
  ];

  for (const method of methods) {
    try {
      const hdrs = method.headers();
      const res = await fetch(`${BASE}/accounts/me`, { headers: hdrs });
      const body = await res.json().catch(() => ({}));
      console.log(`Metode ${method.name} → status ${res.status}, body: ${JSON.stringify(body).slice(0,150)}`);

      if (res.ok && body.success) {
        HEADERS = hdrs;
        console.log(`✅ Autentikasi berhasil dengan ${method.name}`);
        return;
      } else if (res.status === 401) {
        console.warn(`❌ ${method.name} 401 — kemungkinan API key salah`);
      } else if (res.status === 426) {
        console.warn(`❌ ${method.name} 426 — versi tidak cocok`);
      }
    } catch (err) {
      console.warn(`⚠️ ${method.name} error: ${err.message}`);
    }
  }

  console.error('❌ Semua metode autentikasi gagal. Periksa API_KEY.');
  process.exit(1);
}

// ── Mulai ──────────────────────────────────────────────────────
init().then(() => {
  const port = process.env.PORT || 3000;
  startDashboard(port);
  dashboardState.addLog('system', 'Bot started');
  main();                     // <- tidak error lagi karena sudah didefinisikan di atas
});