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

// ── Inisialisasi wallet (jika ada) ─────────────────────────────
let signer = null;
let walletAddress = null;
try {
  const pk = process.env.WALLET_PRIVATE_KEY;
  if (pk && ethers.isHexString(pk, 32)) {
    signer = new ethers.Wallet(pk);
    walletAddress = signer.address;
    console.log(`Wallet EOA terdeteksi: ${walletAddress}`);
  } else {
    console.warn('No valid WALLET_PRIVATE_KEY provided. Paid room disabled.');
  }
} catch (e) {
  console.warn('Gagal membuat signer:', e.message);
}

// ── Main loop dengan State Router ─────────────────────────────
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
    console.log(`Balance (sMoltz): ${me.balance ?? 'tidak diketahui'}`);

    if (!me.readiness.erc8004Id) {
      console.error('No ERC-8004 identity. Exiting.');
      process.exit(0);
    }

    // Update global stats
    if (me.stats) {
      gameStats.totalWins = me.stats.totalWins || 0;
      gameStats.totalMoltz = me.stats.moltz || 0;
      gameStats.totalSmoltz = me.stats.smoltz || 0;
      dashboardState.updateAgent(currentAgentId, gameStats);
    }

    // State Routing
    if (me.currentGames && me.currentGames.length > 0) {
      const game = me.currentGames[0];
      console.log(`Melanjutkan game aktif: ${game.gameId}`);
      return playGameViaAgentSocket(game.gameId);
    }

    // READY_PAID: server mengizinkan paid room
    if (me.readiness.paidReady) {
      if (!signer) {
        console.error('Akun siap PAID room, tapi WALLET_PRIVATE_KEY tidak diset. Tidak bisa lanjut.');
        process.exit(0);
      }
      // Cek saldo untuk mode off‑chain (pakai sMoltz)
      const smoltzBalance = me.balance || 0;
      const ENTRY_FEE_SMOLTZ = 500;   // asumsi dari economy.md
      if (smoltzBalance >= ENTRY_FEE_SMOLTZ) {
        console.log(`sMoltz balance (${smoltzBalance}) mencukupi, masuk PAID room mode offchain.`);
        return joinPaid('offchain');
      } else {
        console.warn(`sMoltz balance (${smoltzBalance}) kurang dari ${ENTRY_FEE_SMOLTZ}, coba mode onchain (Moltz).`);
        // Jika punya Moltz, bisa gunakan mode onchain – perlu dicek dari wallet on‑chain (tidak diimplementasikan detail)
        console.error('Belum ada implementasi pengecekan Moltz on‑chain. Bot berhenti.');
        process.exit(0);
      }
    }

    // READY_FREE: boleh masuk free room
    console.log('Mencoba join free room...');
    return joinFree();
  } catch (error) {
    console.error('Main loop error:', error);
    delayAndRetry(10000);
  }
}

function delayAndRetry(ms) {
  setTimeout(main, ms);
}

// ── WebSocket join untuk free room ─────────────────────────────
function joinFree() {
  const ws = new WebSocket(WS_JOIN, { headers: HEADERS });
  ws.on('open', () => console.log('/ws/join (free) opened'));
  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    console.log('Free join message:', msg.type);
    if (msg.type === 'welcome') {
      const decision = msg.decision;
      console.log(`Server decision: ${decision}`);
      if (decision === 'FREE_ONLY' || decision === 'ASK_ENTRY_TYPE') {
        ws.send(JSON.stringify({ type: 'hello', entryType: 'free' }));
      } else if (decision === 'PAID_ONLY') {
        console.error('Server memaksa PAID room, tapi kita sudah di jalur free. Keluar.');
        ws.close();
        process.exit(0);
      } else if (decision === 'BLOCKED') {
        console.error('Diblokir, reason:', msg.readiness?.reason);
        ws.close();
        process.exit(0);
      }
    } else if (msg.type === 'game_started') {
      dashboardState.addLog(currentAgentId, `Game started: ${msg.gameId}`);
      playGameLoop(ws, msg.gameId);
    } else if (msg.type === 'error') {
      console.error('Join error:', msg.error);
    }
  });
  ws.on('close', (code, reason) => {
    console.log(`Join closed (${code}) ${reason?.toString() || ''}`);
    delayAndRetry(5000);
  });
  ws.on('error', (e) => console.error('WS join error:', e.message));
}

// ── WebSocket join untuk paid room ─────────────────────────────
function joinPaid(mode = 'offchain') {
  const ws = new WebSocket(WS_JOIN, { headers: HEADERS });
  ws.on('open', () => console.log(`/ws/join (paid, mode: ${mode}) opened`));

  ws.on('message', async (data) => {
    const msg = JSON.parse(data.toString());
    console.log('Paid join message:', msg.type);

    if (msg.type === 'welcome') {
      const decision = msg.decision;
      console.log(`Server decision: ${decision}`);
      if (decision === 'PAID_ONLY' || decision === 'ASK_ENTRY_TYPE') {
        // Kirim hello dengan entryType paid dan mode
        ws.send(JSON.stringify({ type: 'hello', entryType: 'paid', mode }));
      } else if (decision === 'BLOCKED') {
        console.error('Diblokir dari paid room:', msg.readiness);
        process.exit(1);
      } else if (decision === 'FREE_ONLY') {
        console.warn('Server hanya menerima free room, fallback.');
        ws.close();
        delayAndRetry(5000); // nanti akan coba free
      }
    } else if (msg.type === 'signature_required') {
      // Server meminta tanda tangan EIP-712
      console.log('Server meminta tanda tangan...');
      try {
        const payload = msg.data?.signaturePayload;
        if (!payload) throw new Error('Payload tidak ada');
        // Asumsikan payload adalah JSON string yang perlu ditandatangani dengan EIP-712
        // Untuk saat ini kita tanda tangani sebagai pesan biasa (EIP-191)
        const signature = await signer.signMessage(payload);
        ws.send(JSON.stringify({
          type: 'signature',
          data: { signature }
        }));
        console.log('Tanda tangan terkirim');
      } catch (e) {
        console.error('Gagal tanda tangan:', e.message);
        ws.close();
      }
    } else if (msg.type === 'game_started') {
      dashboardState.addLog(currentAgentId, `Paid game started: ${msg.gameId}`);
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

// ── Gameplay ───────────────────────────────────────────────────
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

// ── Inisialisasi & autentikasi awal ────────────────────────────
async function init() {
  const rawKey = process.env.API_KEY || '';

  // Ambil versi
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
      console.error('VERSION_MISMATCH, update bot!');
      process.exit(1);
    }
  } catch (e) {
    console.warn('Gagal fetch version, pakai 1.6.0');
  }

  // Autentikasi (dua metode)
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
      }
    } catch (err) {
      console.warn(`⚠️ ${method.name} error: ${err.message}`);
    }
  }

  console.error('❌ Semua metode autentikasi gagal.');
  process.exit(1);
}

// ── Mulai ──────────────────────────────────────────────────────
init().then(() => {
  const port = process.env.PORT || 3000;
  startDashboard(port);
  dashboardState.addLog('system', 'Bot started');
  main();
});