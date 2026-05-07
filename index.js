import 'dotenv/config';
import fetch from 'node-fetch';
import WebSocket from 'ws';
import { ethers } from 'ethers';
import { decideActions } from './strategy.js';
import dashboardState from './state-bridge.js';
import { startDashboard } from './dashboard-server.js';

const BASE     = 'https://cdn.moltyroyale.com/api';
const WS_JOIN  = 'wss://cdn.moltyroyale.com/ws/join';
const WS_AGENT = 'wss://cdn.moltyroyale.com/ws/agent';

let VERSION  = '1.6.0';
let HEADERS  = {};
let currentAgentId = 'primary';
let gameStats = { totalWins: 0, totalMoltz: 0, totalSmoltz: 0, totalCross: 0 };

// Flag global: apakah sedang aktif dalam game loop
let isInGame = false;

/* ── Dashboard helper ───────────────────────────────────────────── */
function updateDashboardFromView(view) {
  const self    = view.self || {};
  const hp      = self.hp    ?? 100;
  const ep      = self.ep    ?? 10;
  const status  = self.isAlive ? 'alive' : 'dead';
  const rewards = { sMoltz: self.rewards?.sMoltz || 0, Moltz: self.rewards?.Moltz || 0 };
  dashboardState.updateAgent(currentAgentId, {
    name: 'BotAgent', hp, ep, status, rewards,
    inventory: self.inventory || [],
  });
}

/* ── Wallet (opsional untuk paid room) ──────────────────────────── */
let signer        = null;
let walletAddress = null;
try {
  const pk = process.env.WALLET_PRIVATE_KEY;
  if (pk && ethers.isHexString(pk, 32)) {
    signer        = new ethers.Wallet(pk);
    walletAddress = signer.address;
    console.log(`Wallet EOA: ${walletAddress}`);
  } else {
    console.warn('No valid WALLET_PRIVATE_KEY. Paid room disabled.');
  }
} catch (e) {
  console.warn('Signer error:', e.message);
}

/* ── Main loop ──────────────────────────────────────────────────── */
async function main() {
  console.log('=== Molty Royale Bot ===');
  try {
    const meRes = await fetch(`${BASE}/accounts/me`, { headers: HEADERS });
    if (!meRes.ok) {
      if (meRes.status === 401) { console.error('Invalid API Key'); process.exit(1); }
      console.error(`/accounts/me error ${meRes.status}`);
      return delayAndRetry(60000);
    }
    const me = (await meRes.json()).data;

    // FIX #3: Cek erc8004Id via /identity, bukan dari readiness
    const identityRes = await fetch(`${BASE}/identity`, { headers: HEADERS });
    const identityData = identityRes.ok ? (await identityRes.json()).data : null;
    const hasIdentity = !!identityData?.erc8004Id;

    console.log(`Identity (ERC-8004): ${hasIdentity ? identityData.erc8004Id : 'MISSING'}`);

    // FIX #4: Cek paid readiness dari field yang benar sesuai docs
    const readiness   = me.readiness || {};
    const isPaidReady = !!(readiness.walletAddress && readiness.whitelistApproved && readiness.scWallet);
    console.log(`Paid Ready: ${isPaidReady}`);
    console.log(`Balance (sMoltz): ${me.balance ?? '?'}`);

    if (!hasIdentity) {
      console.error('No ERC-8004 identity registered. Exiting.');
      process.exit(0);
    }

    if (me.stats) {
      gameStats.totalWins   = me.stats.totalWins   || 0;
      gameStats.totalMoltz  = me.stats.totalMoltz  || me.stats.moltz  || 0;
      gameStats.totalSmoltz = me.stats.totalSmoltz || me.stats.smoltz || 0;
      dashboardState.updateAgent(currentAgentId, gameStats);
    }

    // State Router: lanjutkan game aktif jika ada
    if (me.currentGames && me.currentGames.length > 0) {
      const game = me.currentGames[0];
      console.log(`Melanjutkan game aktif: ${game.gameId}`);
      return playGameViaAgentSocket(game.gameId);
    }

    // Paid room jika siap
    if (isPaidReady) {
      if (!signer) {
        console.error('Paid room ready but no private key. Exiting.');
        process.exit(0);
      }
      const fee     = 500;
      const balance = me.balance || 0;
      if (balance >= fee) {
        console.log(`sMoltz balance ${balance} >= ${fee}. Joining PAID offchain.`);
        return joinRoom('paid');
      } else {
        console.warn(`Insufficient sMoltz (${balance}/${fee}). Fallback ke free room.`);
      }
    }

    // Fallback free room
    console.log('Mencoba join free room...');
    return joinRoom('free');

  } catch (error) {
    console.error('Main loop error:', error);
    delayAndRetry(30000);
  }
}

function delayAndRetry(ms) {
  isInGame = false;
  setTimeout(main, ms);
}

/* ── REST Heartbeat ─────────────────────────────────────────────── */
let lastMainRun = Date.now();
const REST_HEARTBEAT_MS = 300_000; // 5 menit

async function restHeartbeat() {
  // FIX #6: Jangan panggil main() jika sedang dalam game
  if (isInGame) return;
  try {
    const res  = await fetch(`${BASE}/accounts/me`, { headers: HEADERS });
    if (!res.ok) return;
    const me   = (await res.json()).data;
    const hasActiveGame = me.currentGames && me.currentGames.length > 0;
    if (!hasActiveGame && Date.now() - lastMainRun > REST_HEARTBEAT_MS) {
      console.warn('Heartbeat REST: tidak ada game aktif, memanggil main() ulang.');
      lastMainRun = Date.now();
      main();
    }
  } catch (_) { /* abaikan */ }
}

/* ══════════════════════════════════════════════════════════════════
   UNIFIED JOIN WEBSOCKET (free + paid)
   Docs: server → welcome → client → hello → server → game loop
   ══════════════════════════════════════════════════════════════════ */

// FIX #1/#5: Unified join handler sesuai docs
function joinRoom(entryType = 'free') {
  const ws = new WebSocket(WS_JOIN, { headers: HEADERS });
  let gameStarted = false;

  ws.on('open', () => {
    console.log(`/ws/join (${entryType}) opened`);
    setIdleWatchdog(ws, `join-${entryType}`, 120_000);
  });

  ws.on('message', async (data) => {
    const msg = JSON.parse(data.toString());
    console.log(`Join msg [${entryType}]:`, msg.type);

    switch (msg.type) {

      // FIX #5: Handle ALREADY_IN_GAME — server langsung proxy, tidak perlu hello
      case 'welcome': {
        const decision = msg.decision;
        console.log(`Decision: ${decision}`);

        if (decision === 'ALREADY_IN_GAME') {
          console.log('ALREADY_IN_GAME: socket di-proxy langsung ke game aktif.');
          gameStarted = true;
          playGameLoop(ws, 'resumed');
          return;
        }

        if (decision === 'BLOCKED') {
          console.error('Diblokir:', JSON.stringify(msg.readiness));
          ws.close();
          process.exit(0);
        }

        if (entryType === 'free') {
          if (decision === 'PAID_ONLY') {
            console.error('Server memaksa PAID room, bot tidak ada private key atau balance. Keluar.');
            ws.close();
            process.exit(0);
          }
          // FREE_ONLY atau ASK_ENTRY_TYPE
          ws.send(JSON.stringify({ type: 'hello', entryType: 'free' }));

        } else {
          // paid
          if (decision === 'FREE_ONLY') {
            console.warn('Server hanya menerima free. Fallback ke free room.');
            ws.close();
            return joinRoom('free');
          }
          ws.send(JSON.stringify({ type: 'hello', entryType: 'paid', mode: 'offchain' }));
        }
        break;
      }

      // Paid: server minta signature EIP-712
      case 'signature_required':
      case 'sign_required': {
        console.log('Server meminta signature...');
        try {
          const payload = msg.data?.signaturePayload || msg.signaturePayload;
          if (!payload) throw new Error('No signaturePayload');
          const signature = await signer.signMessage(payload);
          ws.send(JSON.stringify({ type: 'sign_submit', data: { signature } }));
          console.log('Signature terkirim.');
        } catch (e) {
          console.error('Signature failed:', e.message);
          ws.close();
        }
        break;
      }

      // Game dimulai via join socket
      case 'agent_view':
        if (!gameStarted) {
          gameStarted = true;
          const gameId = msg.gameId || 'unknown';
          dashboardState.addLog(currentAgentId, `Game dimulai (agent_view): ${gameId}`);
          playGameLoop(ws, gameId, msg); // lempar pesan pertama langsung
        }
        break;

      case 'game_started':
        if (!gameStarted) {
          gameStarted = true;
          dashboardState.addLog(currentAgentId, `Game dimulai: ${msg.gameId}`);
          playGameLoop(ws, msg.gameId);
        }
        break;

      case 'not_selected':
        console.log('Free room: tidak terpilih siklus ini. Re-dial...');
        dashboardState.addLog(currentAgentId, 'not_selected — re-dial free room');
        // ws akan ditutup server, handler close akan retry
        break;

      case 'queued':
        console.log('Antri menunggu game...');
        break;

      case 'tx_submitted':
        console.log(`Paid: tx submitted ${msg.txHash}`);
        break;

      case 'error':
        console.error(`Join error [${entryType}]:`, msg.code, msg.message);
        ws.close();
        break;
    }
  });

  ws.on('close', (code, reason) => {
    if (gameStarted) return; // game loop sudah mengambil alih
    const reasonStr = reason?.toString() || '';
    console.log(`Join closed (${code}) ${reasonStr}`);
    if (code === 4503 && reasonStr.includes('MAINTENANCE')) {
      console.warn('Server maintenance. Menunggu 5 menit.');
      dashboardState.addLog('system', 'Server maintenance, retrying in 5 min');
      setTimeout(main, 300_000);
    } else {
      delayAndRetry(5000);
    }
  });

  ws.on('error', (e) => console.error(`WS join error [${entryType}]:`, e.message));
}

/* ══════════════════════════════════════════════════════════════════
   GAMEPLAY LOOP
   FIX #1: Format aksi sesuai docs: { type:'action', data:{...} }
   FIX #6: Track cooldown via action_result & can_act_changed
   FIX #7: Satu flag gameEnded agar tidak double-retry
   ══════════════════════════════════════════════════════════════════ */

function playGameLoop(ws, gameId, firstMsg = null) {
  console.log(`Playing game ${gameId}`);
  isInGame = true;

  // Hapus semua listener lama dari join phase sebelum pasang yang baru
  // FIX #1: Hilangkan duplicate listener
  ws.removeAllListeners('message');
  ws.removeAllListeners('close');
  ws.removeAllListeners('error');

  let currentState  = null;
  let canAct        = true;   // FIX #6: tracking cooldown
  let gameEnded     = false;  // FIX #7: anti double-retry

  // Idle watchdog
  let idleTimeout;
  const resetIdle = () => {
    clearTimeout(idleTimeout);
    idleTimeout = setTimeout(() => {
      console.warn('Idle watchdog: tidak ada pesan 120 detik, disconnect.');
      ws.close();
    }, 120_000);
  };

  // Helper kirim aksi — semua aksi dikemas sesuai format docs
  function sendActions(state) {
    // FIX #1: format { type:'action', data:{...}, thought:{...} }
    const rawActions = decideActions(state, canAct);
    for (const raw of rawActions) {
      // strategy.js mengembalikan { action, data, reason }
      // Kita wrap ke format resmi docs
      const packet = {
        type: 'action',
        data: {
          type: raw.action,
          ...(raw.data || {}),
        },
        thought: {
          reasoning: raw.reason || '',
          plannedAction: raw.action || '',
        },
      };
      ws.send(JSON.stringify(packet));
    }
  }

  function handleMessage(data) {
    resetIdle();
    const msg = JSON.parse(data.toString());

    // Update state dari semua snapshot server
    if (msg.type === 'agent_view' || msg.type === 'state' || msg.type === 'turn') {
      currentState = msg;
      updateDashboardFromView(msg.view ? msg : { self: msg.self });
    }

    switch (msg.type) {

      // Turn baru — kirim aksi jika canAct
      case 'turn_advanced':
      case 'state':
      case 'turn':
        if (!currentState) {
          // Belum ada state, defend sementara
          ws.send(JSON.stringify({ type: 'action', data: { type: 'rest' }, thought: { reasoning: 'no state yet' } }));
          return;
        }
        if (canAct) sendActions(currentState);
        break;

      // FIX #6: action_result memberi tahu apakah bisa aksi lagi
      case 'action_result':
        canAct = msg.canAct ?? true;
        // Update state jika ada view terbaru
        if (msg.view || msg.self) {
          currentState = { ...(currentState || {}), ...msg };
          updateDashboardFromView(msg.view ? msg : { self: msg.self });
        }
        if (msg.success === false) {
          dashboardState.addLog(currentAgentId, `Action rejected: ${msg.error?.code} — ${msg.error?.message}`);
        }
        break;

      // FIX #6: cooldown selesai — boleh aksi lagi
      case 'can_act_changed':
        canAct = msg.canAct ?? true;
        if (canAct && currentState) {
          sendActions(currentState);
        }
        break;

      // Event realtime (combat, movement, dll) — update state tapi tidak trigger aksi
      case 'event':
        dashboardState.addLog(currentAgentId, msg.message || JSON.stringify(msg.data || {}));
        break;

      // Pong dari ping kita
      case 'pong':
        break;

      // Game selesai
      case 'game_ended': {
        if (gameEnded) return; // FIX #7: guard double
        gameEnded = true;
        isInGame  = false;
        clearTimeout(idleTimeout);

        const rewards = msg.rewards || {};
        gameStats.totalWins   += msg.isWinner ? 1 : 0;
        gameStats.totalSmoltz += rewards.sMoltz || 0;
        gameStats.totalMoltz  += rewards.Moltz  || 0;
        dashboardState.updateAgent(currentAgentId, gameStats);
        dashboardState.addLog(currentAgentId,
          `Game ended. Winner: ${msg.winnerId}. isWinner: ${msg.isWinner}`);

        ws.close();
        delayAndRetry(5000);
        break;
      }
    }
  }

  ws.on('message', handleMessage);

  ws.on('close', (code) => {
    clearTimeout(idleTimeout);
    isInGame = false;
    console.log(`Game WS closed (${code})`);
    if (!gameEnded) {  // FIX #7: hanya retry jika bukan penutupan normal
      delayAndRetry(5000);
    }
  });

  ws.on('error', (e) => console.error('Game WS error:', e.message));

  // Mulai idle timer
  resetIdle();

  // Jika ada pesan pertama yang sudah diterima di fase join (agent_view pertama),
  // proses langsung tanpa menunggu event berikutnya
  if (firstMsg) handleMessage(JSON.stringify(firstMsg));
}

/* ── Connect langsung ke game aktif via /ws/agent ──────────────── */
function playGameViaAgentSocket(gameId) {
  const ws = new WebSocket(WS_AGENT, { headers: HEADERS });
  ws.on('open', () => {
    console.log('/ws/agent opened');
    playGameLoop(ws, gameId);
  });
  ws.on('error', (e) => console.error('Agent WS error:', e.message));
}

/* ── Idle watchdog helper (untuk fase join) ─────────────────────── */
function setIdleWatchdog(ws, label, ms) {
  let timer;
  const reset = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      console.warn(`Idle watchdog [${label}]: tidak ada respons, disconnect.`);
      ws.close();
    }, ms);
  };
  ws.on('message', reset);
  ws.on('close', () => clearTimeout(timer));
  reset();
}

/* ── Init & auth ────────────────────────────────────────────────── */
async function init() {
  const rawKey = process.env.API_KEY || '';

  // Ambil versi server
  try {
    const vRes = await fetch(`${BASE}/version`, { headers: { 'X-Version': '1.6.0' } });
    if (vRes.ok) {
      const vData = await vRes.json();
      if (vData.success && vData.data?.version) {
        VERSION = vData.data.version;
        console.log(`Server version: ${VERSION}`);
      }
    } else if (vRes.status === 426) {
      console.error('VERSION_MISMATCH');
      process.exit(1);
    }
  } catch (e) {
    console.warn('Version fetch failed, using default:', VERSION);
  }

  // FIX #2: Prioritas metode auth dibalik — X-API-Key dulu (sesuai docs resmi)
  const methods = [
    {
      name: 'x-api-key',
      headers: () => ({
        'X-Version':    VERSION,
        'Content-Type': 'application/json',
        'X-API-Key':    rawKey,
      }),
    },
    {
      name: 'mr-auth',
      headers: () => ({
        'X-Version':     VERSION,
        'Content-Type':  'application/json',
        'Authorization': `mr-auth ${rawKey}`,
      }),
    },
  ];

  for (const method of methods) {
    try {
      const hdrs = method.headers();
      const res  = await fetch(`${BASE}/accounts/me`, { headers: hdrs });
      const body = await res.json().catch(() => ({}));
      console.log(`Auth ${method.name} → ${res.status} ${JSON.stringify(body).slice(0, 80)}`);
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

/* ── Mulai ──────────────────────────────────────────────────────── */
init().then(() => {
  const port = process.env.PORT || 3000;
  startDashboard(port);
  dashboardState.addLog('system', 'Bot started');

  lastMainRun = Date.now();
  main();

  setInterval(restHeartbeat, REST_HEARTBEAT_MS);
});
