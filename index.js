// index.js — perbaikan untuk masalah version fetch dan API key
import 'dotenv/config';
import fetch from 'node-fetch';
import WebSocket from 'ws';
import { decideActions } from './strategy.js';
import dashboardState from './state-bridge.js';
import { startDashboard } from './dashboard-server.js';

const BASE = 'https://cdn.moltyroyale.com/api';
const WS_JOIN = 'wss://cdn.moltyroyale.com/ws/join';
const WS_AGENT = 'wss://cdn.moltyroyale.com/ws/agent';

let VERSION = 'unknown';
let HEADERS = {};

async function init() {
  try {
    // Versi awal dikirim sebagai "0.0.0" untuk pertama kali, server akan memberitahu versi terbaru
    const tempHeaders = { 'X-Version': '0.0.0' };
    const vRes = await fetch(`${BASE}/version`, { headers: tempHeaders });
    if (vRes.status === 426) {
      console.error('VERSION_MISMATCH: Update bot atau periksa ulang versi.');
      process.exit(1);
    }
    const vData = await vRes.json();
    if (vData.success && vData.data && vData.data.version) {
      VERSION = vData.data.version;
      console.log(`Versi server: ${VERSION}`);
    } else {
      console.warn('Gagal membaca versi dari server, menggunakan "unknown". Response:', vData);
    }
  } catch (e) {
    console.warn('Version fetch gagal, menggunakan "unknown". Error:', e.message);
  }

  HEADERS = {
    'X-Version': VERSION,
    'Authorization': `mr-auth ${process.env.API_KEY}`,
    'Content-Type': 'application/json'
  };
}

// ... sisa kode sama seperti sebelumnya ...

async function main() {
  console.log('=== Molty Royale Bot ===');
  try {
    const meRes = await fetch(`${BASE}/accounts/me`, { headers: HEADERS });
    if (!meRes.ok) {
      const errData = await meRes.json().catch(() => ({}));
      if (meRes.status === 401) {
        console.error('❌ API Key tidak valid. Pastikan API_KEY di environment variable sudah benar.');
        console.error('Format: mr_live_....');
        process.exit(0); // keluar dengan sukses agar Railway tidak merestart terus-menerus
      }
      console.error(`/accounts/me gagal (${meRes.status}):`, errData);
      return delayAndRetry(60000);
    }

    const me = (await meRes.json()).data;
    console.log(`Identity: ${me.readiness.erc8004Id ? 'OK' : 'MISSING'}`);

    if (!me.readiness.erc8004Id) {
      console.error('Tidak ada identitas ERC-8004. Bot tidak bisa bermain free room.');
      console.error('Buat identitas dulu: POST /api/whitelist/request + transaksi on-chain.');
      process.exit(0);
    }

    // Update global stats jika ada
    if (me.stats) {
      gameStats.totalWins = me.stats.totalWins || 0;
      gameStats.totalMoltz = me.stats.moltz || 0;
      gameStats.totalSmoltz = me.stats.smoltz || 0;
      dashboardState.updateAgent(currentAgentId, gameStats);
    }

    if (me.currentGames && me.currentGames.length > 0) {
      const game = me.currentGames[0];
      console.log(`Melanjutkan game aktif: ${game.gameId}`);
      return playGameViaAgentSocket(game.gameId);
    }

    const entryType = process.env.ENTRY_TYPE || 'free';
    if (entryType === 'paid') {
      console.warn('Mode paid belum diimplementasikan.');
      process.exit(0);
    } else {
      return joinFree();
    }
  } catch (error) {
    console.error('Error main loop:', error);
    delayAndRetry(10000);
  }
}

// ... (fungsi joinFree, playGameLoop, dll. tetap sama) ...

init().then(() => {
  const port = process.env.PORT || 3000;
  startDashboard(port);
  dashboardState.addLog('system', 'Bot started');
  main();
});