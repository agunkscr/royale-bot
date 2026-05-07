import 'dotenv/config';
import fetch from 'node-fetch';
import WebSocket from 'ws';
import { decideActions } from './strategy.js';
import dashboardState from './state-bridge.js';
import { startDashboard } from './dashboard-server.js';

const BASE = 'https://cdn.moltyroyale.com/api';
const WS_JOIN = 'wss://cdn.moltyroyale.com/ws/join';
const WS_AGENT = 'wss://cdn.moltyroyale.com/ws/agent';

let VERSION = '1.6.0'; // fallback dari skill.md
let HEADERS = {};

async function init() {
  const rawKey = process.env.API_KEY || '';

  // 1. Coba ambil versi terbaru dengan header sementara (versi fallback)
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
      console.error('VERSION_MISMATCH: server minta versi lebih baru. Update bot!');
      process.exit(1);
    } else {
      console.warn(`/version unexpected ${vRes.status}, pakai fallback.`);
    }
  } catch (e) {
    console.warn('Gagal fetch /version, pakai fallback 1.6.0. Error:', e.message);
  }

  // 2. Uji autentikasi dengan dua metode
  const methods = [
    {
      name: 'mr-auth',
      buildHeaders: (v) => ({
        'X-Version': v,
        'Content-Type': 'application/json',
        'Authorization': `mr-auth ${rawKey}`
      })
    },
    {
      name: 'x-api-key',
      buildHeaders: (v) => ({
        'X-Version': v,
        'Content-Type': 'application/json',
        'X-API-Key': rawKey
      })
    }
  ];

  let authOk = false;
  let chosenHeaders = null;

  for (const method of methods) {
    const headers = method.buildHeaders(VERSION);
    try {
      const res = await fetch(`${BASE}/accounts/me`, { headers });
      const body = await res.json().catch(() => ({}));
      console.log(`Metode ${method.name} → status ${res.status}, body: ${JSON.stringify(body).slice(0,150)}`);

      if (res.ok && body.success) {
        authOk = true;
        chosenHeaders = headers;
        console.log(`✅ Autentikasi berhasil dengan ${method.name}`);
        break;
      } else if (res.status === 401) {
        console.warn(`❌ ${method.name} 401 — kemungkinan API key salah`);
      } else if (res.status === 426) {
        console.warn(`❌ ${method.name} 426 — versi tidak cocok, coba update VERSION`);
      } else {
        console.warn(`⚠️ ${method.name} status ${res.status}`);
      }
    } catch (err) {
      console.warn(`⚠️ ${method.name} error: ${err.message}`);
    }
  }

  if (!authOk) {
    console.error('❌ Semua metode autentikasi gagal.');
    console.error('1. Pastikan API_KEY di Railway benar, berawalan "mr_live_"');
    console.error('2. Pastikan tidak ada spasi / newline di value');
    console.error('3. Jika key benar, mungkin endpoint berubah, cek dashboard Molty Royale');
    process.exit(1);
  }

  HEADERS = chosenHeaders;
}

// ... sisa kode (updateDashboardFromView, main, joinFree, dll.) tetap persis sama ...

// Jalankan
init().then(() => {
  const port = process.env.PORT || 3000;
  startDashboard(port);
  dashboardState.addLog('system', 'Bot started');
  main();
});