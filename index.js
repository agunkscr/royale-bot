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

// ── Fungsi bantu untuk dashboard ────────────────────────────────
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

// ── Wallet EOA (untuk paid room) ────────────────────────────────
let signer = null;
let walletAddress = null;
try {
  const pk = process.env.WALLET_PRIVATE_KEY;
  if (pk && ethers.isHexString(pk, 32)) {
    signer = new ethers.Wallet(pk);
    walletAddress = signer.address;
    console.log(`Wallet EOA terdeteksi: ${walletAddress}`);
  } else {
    console.warn('Tidak ada WALLET_PRIVATE_KEY yang valid. Mode paid dinonaktifkan.');
  }
} catch (e) {
  console.warn('Gagal membuat signer:', e.message);
}

// ── Fungsi utama State Router ─────────────────────────────────
async function main() {
  console.log('=== Molty Royale Bot ===');
  try {
    const meRes = await fetch(`${BASE}/accounts/me`, { headers: HEADERS });
    if (!meRes.ok) {
      if (meRes.status === 401) {
        console.error('API Key tidak valid. Periksa kembali.');
        process.exit(1);
      }
      console.error(`/accounts/me gagal (${meRes.status})`);
      return delayAndRetry(60000);
    }

    const me = (await meRes.json()).data;
    console.log(`Identity: ${me.readiness.erc8004Id ? 'OK' : 'MISSING'}`);
    console.log(`Paid Ready: ${me.readiness.paidReady}`);
    console.log(`Saldo (sMoltz): ${me.balance ?? 'tidak diketahui'}`);

    // Update saldo ke dashboard
    if (me.balance !== undefined) {
      gameStats.totalSmoltz = me.balance;
      dashboardState.updateAgent(currentAgentId, { totalSmoltz: me.balance });
    }

    if (!me.readiness.erc8004Id) {
      console.error('Belum memiliki identitas ERC‑8004. Bot tidak bisa bermain.');
      process.exit(0);
    }

    // Update statistik global dari server (jika ada)
    if (me.stats) {
      gameStats.totalWins = me.stats.totalWins || 0;
      gameStats.totalMoltz = me.stats.moltz || 0;
      gameStats.totalSmoltz = me.stats.smoltz || gameStats.totalSmoltz;
      dashboardState.updateAgent(currentAgentId, gameStats);
    }

    // State Router sesuai skill.md
    if (me.currentGames && me.currentGames.length > 0) {
      const game = me.currentGames[0];
      console.log(`Melanjutkan game aktif: ${game.gameId}`);
      return playGameViaAgentSocket(game.gameId);
    }

    if (me.readiness.paidReady) {
      if (!signer) {
        console.error('Akun siap PAID room, tapi WALLET_PRIVATE_KEY tidak diset. Bot berhenti.');
        process.exit(0);
      }
      const ENTRY_FEE_SMOLTZ = 500;
      const balance = me.balance || 0;
      if (balance >= ENTRY_FEE_SMOLTZ) {
        console.log(`Saldo ${balance} sMoltz mencukupi. Masuk PAID room (offchain)...`);
        return joinPaid('offchain');
      } else {
        console.error(`Saldo sMoltz (${balance}) tidak cukup (butuh ${ENTRY_FEE_SMOLTZ}). Bot berhenti.`);
        process.exit(0);
      }
    }

    // Default: free room
    console.log('Mencoba masuk free room...');
    return joinFree();
  } catch (error) {
    console.error('Error di main loop:', error);
    delayAndRetry(30000);
  }
}

function delayAndRetry(ms) {
  console.log(`Menunggu ${ms / 1000} detik sebelum mencoba lagi...`);
  setTimeout(main, ms);
}

// ── WebSocket join: Free Room ──────────────────────────────────
function joinFree() {
  const ws = new WebSocket(WS_JOIN, { headers: HEADERS });
  ws.on('open', () => console.log('/ws/join (free) terbuka'));

  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    console.log('Free join msg:', msg.type);
    if (msg.type === 'welcome') {
      const decision = msg.decision;
      console.log(`Server decision: ${decision}`);
      if (decision === 'FREE_ONLY' || decision === 'ASK_ENTRY_TYPE') {
        ws.send(JSON.stringify({ type: 'hello', entryType: 'free' }));
      } else if (decision === 'PAID_ONLY') {
        console.error('Server memaksa PAID room. Bot keluar.');
        ws.close();
        process.exit(0);
      } else if (decision === 'BLOCKED') {
        console.error('Diblokir dari free room:', msg.readiness);
        ws.close();
        process.exit(0);
      }
    } else if (msg.type === 'game_started') {
      dashboardState.addLog(currentAgentId, `Game dimulai: ${msg.gameId}`);
      playGameLoop(ws, msg.gameId);
    } else if (msg.type === 'error') {
      console.error('Join error:', msg.error);
    }
  });

  ws.on('close', (code, reason) => {
    const reasonStr = reason?.toString() || '';
    console.log(`Join free ditutup (${code}) ${reasonStr}`);
    if (code === 4503 && reasonStr.includes('MAINTENANCE')) {
      console.warn('Server maintenance, menunggu 5 menit...');
      dashboardState.addLog('system', 'Server maintenance, coba lagi 5 menit');
      setTimeout(main, 300000);
    } else {
      delayAndRetry(5000);
    }
  });

  ws.on('error', (e) => console.error('Error WS free:', e.message));
}

// ── WebSocket join: Paid Room ──────────────────────────────────
function joinPaid(mode = 'offchain') {
  const ws = new WebSocket(WS_JOIN, { headers: HEADERS });
  ws.on('open', () => console.log(`/ws/join (paid, ${mode}) terbuka`));

  ws.on('message', async (data) => {
    const msg = JSON.parse(data.toString());
    console.log('Paid join msg:', msg.type);
    if (msg.type === 'welcome') {
      const decision = msg.decision;
      console.log(`Server decision: ${decision}`);
      if (decision === 'PAID_ONLY' || decision === 'ASK_ENTRY_TYPE') {
        ws.send(JSON.stringify({ type: 'hello', entryType: 'paid', mode }));
      } else if (decision === 'FREE_ONLY') {
        console.warn('Server hanya menerima free room. Fallback.');
        ws.close();
        delayAndRetry(5000);
      } else if (decision === 'BLOCKED') {
        console.error('Diblokir dari paid room:', msg.readiness);
        process.exit(0);
      }
    } else if (msg.type === 'signature_required') {
      console.log('Server meminta tanda tangan...');
      try {
        const payload = msg.data?.signaturePayload;
        if (!payload) throw new Error('Payload tidak ada');
        const signature = await signer.signMessage(payload);
        ws.send(JSON.stringify({ type: 'signature', data: { signature } }));
        console.log('Tanda tangan terkirim');
      } catch (e) {
        console.error('Gagal tanda tangan:', e.message);
        ws.close();
      }
    } else if (msg.type === 'game_started') {
      dashboardState.addLog(currentAgentId, `Paid game dimulai: ${msg.gameId}`);
      playGameLoop(ws, msg.gameId);
    } else if (msg.type === 'error') {
      console.error('Paid join error:', msg.error);
      ws.close();
    }
  });

  ws.on('close', (code) => {
    console.log(`Paid join ditutup (${code})`);
    delayAndRetry(5000);
  });
  ws.on('error', (e) => console.error('Error WS paid:', e.message));
}

// ── Gameplay Loop ──────────────────────────────────────────────
function playGameLoop(ws, gameId) {
  console.log(`Memainkan game ${gameId}`);
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
      dashboardState.addLog(currentAgentId, `Game selesai. Pemenang: ${msg.winnerId}`);
      ws.close();
      delayAndRetry(5000);
    }
  });

  ws.on('close', (code) => {
    console.log(`Game WS ditutup (${code})`);
    delayAndRetry(5000);
  });
}

function playGameViaAgentSocket(gameId) {
  const ws = new WebSocket(WS_AGENT, { headers: HEADERS });
  ws.on('open', () => playGameLoop(ws, gameId));
  ws.on('error', (e) => console.error('Error WS agent:', e.message));
}

// ── Inisialisasi & Autentikasi ─────────────────────────────────
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
        console.log(`Versi server: ${VERSION}`);
      } else {
        console.warn('Gagal parse versi, tetap gunakan 1.6.0');
      }
    } else if (vRes.status === 426) {
      console.error('VERSION_MISMATCH, update bot!');
      process.exit(1);
    }
  } catch (e) {
    console.warn('Gagal fetch versi, gunakan 1.6.0');
  }

  // Coba dua metode autentikasi
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
      console.log(`Auth ${method.name} → ${res.status} ${JSON.stringify(body).slice(0,120)}`);
      if (res.ok && body.success) {
        HEADERS = hdrs;
        console.log(`✅ Autentikasi berhasil dengan ${method.name}`);
        return;
      }
    } catch (err) {
      console.warn(`Auth ${method.name} error: ${err.message}`);
    }
  }

  console.error('❌ Semua metode autentikasi gagal.');
  process.exit(1);
}

// ── Mulai ─────────────────────────────────────────────────────
init().then(() => {
  const port = process.env.PORT || 3000;
  startDashboard(port);
  dashboardState.addLog('system', 'Bot dimulai');
  main();
});