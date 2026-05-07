import 'dotenv/config';
import fetch from 'node-fetch';
import WebSocket from 'ws';
import { ethers } from 'ethers';
import { decideActions } from './strategy.js';
import dashboardState from './state-bridge.js';
import { startDashboard } from './dashboard-server.js';

const BASE = 'https://cdn.moltyroyale.com/api';
const WS_JOIN = 'wss://cdn.moltyroyale.com/ws/join';
const WS_AGENT = 'wss://cdn.moltyroyale.com/ws/agent';

let VERSION = '1.6.0';
let HEADERS = {};
let currentAgentId = 'primary';
let gameStats = { totalWins: 0, totalMoltz: 0, totalSmoltz: 0, totalCross: 0 };

/* ── Bantu update dashboard ─────────────────────────────────── */
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

/* ── Wallet (opsional untuk paid room) ──────────────────────── */
let signer = null;
let walletAddress = null;
try {
  const pk = process.env.WALLET_PRIVATE_KEY;
  if (pk && ethers.isHexString(pk, 32)) {
    signer = new ethers.Wallet(pk);
    walletAddress = signer.address;
    console.log(`Wallet EOA: ${walletAddress}`);
  } else {
    console.warn('No valid WALLET_PRIVATE_KEY. Paid room disabled.');
  }
} catch (e) {
  console.warn('Signer error:', e.message);
}

/* ── Main loop ─────────────────────────────────────────────── */
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
    console.log(`Paid Ready: ${me.readiness.paidReady}`);
    console.log(`Balance (sMoltz): ${me.balance ?? '?'}`);

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

    // State Router: lanjutkan game jika ada
    if (me.currentGames && me.currentGames.length > 0) {
      const game = me.currentGames[0];
      console.log(`Melanjutkan game aktif: ${game.gameId}`);
      return playGameViaAgentSocket(game.gameId);
    }

    // Paid room jika siap
    if (me.readiness.paidReady) {
      if (!signer) {
        console.error('Paid room ready but no private key. Exiting.');
        process.exit(0);
      }
      const fee = 500;
      const balance = me.balance || 0;
      if (balance >= fee) {
        console.log(`sMoltz balance ${balance} >= ${fee}. Joining PAID offchain.`);
        return joinPaid('offchain');
      } else {
        console.warn(`Insufficient sMoltz (${balance}/${fee}). Cannot enter paid room.`);
        process.exit(0);
      }
    }

    // Fallback free room
    console.log('Mencoba join free room...');
    return joinFree();
  } catch (error) {
    console.error('Main loop error:', error);
    delayAndRetry(30000);
  }
}

function delayAndRetry(ms) {
  setTimeout(main, ms);
}

/* ── WebSocket join free room ──────────────────────────────── */
function joinFree() {
  const ws = new WebSocket(WS_JOIN, { headers: HEADERS });
  let gameStarted = false;

  ws.on('open', () => console.log('/ws/join (free) opened'));

  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    console.log('Free join msg:', msg.type);

    if (msg.type === 'welcome') {
      const decision = msg.decision;
      console.log(`Decision: ${decision}`);
      if (decision === 'FREE_ONLY' || decision === 'ASK_ENTRY_TYPE') {
        ws.send(JSON.stringify({ type: 'hello', entryType: 'free' }));
      } else if (decision === 'PAID_ONLY') {
        console.error('Server memaksa PAID room. Keluar.');
        ws.close();
        process.exit(0);
      } else if (decision === 'BLOCKED') {
        console.error('Diblokir:', msg.readiness);
        ws.close();
        process.exit(0);
      }
    } else if (msg.type === 'agent_view' && !gameStarted) {
      gameStarted = true;
      const gameId = msg.gameId || 'unknown';
      dashboardState.addLog(currentAgentId, `Game dimulai (agent_view): ${gameId}`);
      playGameLoop(ws, gameId);
    } else if (msg.type === 'game_started' && !gameStarted) {
      gameStarted = true;
      dashboardState.addLog(currentAgentId, `Game dimulai: ${msg.gameId}`);
      playGameLoop(ws, msg.gameId);
    } else if (msg.type === 'error') {
      console.error('Join error:', msg.error);
    }
  });

  ws.on('close', (code, reason) => {
    const reasonStr = reason?.toString() || '';
    console.log(`Join closed (${code}) ${reasonStr}`);
    if (code === 4503 && reasonStr.includes('MAINTENANCE')) {
      console.warn('Server dalam pemeliharaan. Menunggu 5 menit.');
      dashboardState.addLog('system', 'Server maintenance, retrying in 5 min');
      setTimeout(main, 300000);
    } else {
      delayAndRetry(5000);
    }
  });

  ws.on('error', (e) => console.error('WS join error:', e.message));
}

/* ── WebSocket join paid room ──────────────────────────────── */
function joinPaid(mode = 'offchain') {
  const ws = new WebSocket(WS_JOIN, { headers: HEADERS });
  let gameStarted = false;

  ws.on('open', () => console.log(`/ws/join (paid, ${mode}) opened`));

  ws.on('message', async (data) => {
    const msg = JSON.parse(data.toString());
    console.log('Paid join msg:', msg.type);

    if (msg.type === 'welcome') {
      const decision = msg.decision;
      console.log(`Decision: ${decision}`);
      if (decision === 'PAID_ONLY' || decision === 'ASK_ENTRY_TYPE') {
        ws.send(JSON.stringify({ type: 'hello', entryType: 'paid', mode }));
      } else if (decision === 'FREE_ONLY') {
        console.warn('Server hanya menerima free. Fallback.');
        ws.close();
        delayAndRetry(5000);
      } else if (decision === 'BLOCKED') {
        console.error('Blocked from paid:', msg.readiness);
        process.exit(0);
      }
    } else if (msg.type === 'signature_required') {
      console.log('Server requests signature...');
      try {
        const payload = msg.data?.signaturePayload;
        if (!payload) throw new Error('No payload');
        const signature = await signer.signMessage(payload);
        ws.send(JSON.stringify({ type: 'signature', data: { signature } }));
        console.log('Signature sent');
      } catch (e) {
        console.error('Signature failed:', e.message);
        ws.close();
      }
    } else if (msg.type === 'agent_view' && !gameStarted) {
      gameStarted = true;
      const gameId = msg.gameId || 'unknown';
      dashboardState.addLog(currentAgentId, `Paid game dimulai (agent_view): ${gameId}`);
      playGameLoop(ws, gameId);
    } else if (msg.type === 'game_started' && !gameStarted) {
      gameStarted = true;
      dashboardState.addLog(currentAgentId, `Paid game dimulai: ${msg.gameId}`);
      playGameLoop(ws, msg.gameId);
    } else if (msg.type === 'error') {
      console.error('Paid join error:', msg.error);
      ws.close();
    }
  });

  ws.on('close', (code) => {
    console.log(`Paid join closed (${code})`);
    delayAndRetry(5000);
  });
  ws.on('error', (e) => console.error('WS paid error:', e.message));
}

/* ── Gameplay loop (aksi dikirim setiap turn_advanced/state/turn) ─ */
function playGameLoop(ws, gameId) {
  console.log(`Playing game ${gameId}`);
  let currentState = null;

  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());

    // Perbarui state dari semua informasi dunia
    if (msg.type === 'state' || msg.type === 'turn' || msg.type === 'agent_view') {
      currentState = msg;
      updateDashboardFromView(msg);
    }

    // Kirim aksi setiap kali server memberi sinyal giliran baru
    if (msg.type === 'turn_advanced' || msg.type === 'state' || msg.type === 'turn') {
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

/* ── Sambung langsung ke game aktif ────────────────────────── */
function playGameViaAgentSocket(gameId) {
  const ws = new WebSocket(WS_AGENT, { headers: HEADERS });
  ws.on('open', () => playGameLoop(ws, gameId));
  ws.on('error', (e) => console.error('Agent WS error:', e.message));
}

/* ── Inisialisasi & autentikasi awal ───────────────────────── */
async function init() {
  const rawKey = process.env.API_KEY || '';

  // Ambil versi server
  try {
    const vRes = await fetch(`${BASE}/version`, {
      headers: { 'X-Version': '1.6.0' }
    });
    if (vRes.ok) {
      const vData = await vRes.json();
      if (vData.success && vData.data?.version) {
        VERSION = vData.data.version;
        console.log(`Server version: ${VERSION}`);
      } else {
        console.warn('Could not parse version, using 1.6.0');
      }
    } else if (vRes.status === 426) {
      console.error('VERSION_MISMATCH');
      process.exit(1);
    }
  } catch (e) {
    console.warn('Version fetch failed, using 1.6.0');
  }

  // Coba beberapa metode autentikasi
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
      console.log(`Auth ${method.name} → ${res.status} ${JSON.stringify(body).slice(0,100)}`);
      if (res.ok && body.success) {
        HEADERS = hdrs;
        console.log(`✅ Authenticated via ${method.name}`);
        return;
      }
    } catch (err) {
      console.warn(`Auth ${method.name} error: ${err.message}`);
    }
  }

  console.error('❌ All auth methods failed.');
  process.exit(1);
}

// ── Mulai ──────────────────────────────────────────────────────
init().then(() => {
  const port = process.env.PORT || 3000;
  startDashboard(port);
  dashboardState.addLog('system', 'Bot started');
  main();
});