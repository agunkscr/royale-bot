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
  const rawKey = process.env.API_KEY || '';
  
  // 1. Ambil versi server
  try {
    const vRes = await fetch(`${BASE}/version`, {
      headers: { 'X-Version': '0.0.0' }
    });
    if (vRes.status === 426) {
      console.error('VERSION_MISMATCH: server menolak, mungkin butuh update client.');
      process.exit(1);
    }
    const vData = await vRes.json();
    if (vData.success && vData.data?.version) {
      VERSION = vData.data.version;
    } else {
      console.warn('Respons version tidak dikenal, pakai default.');
    }
  } catch (e) {
    console.warn('Gagal fetch version, lanjut dengan "unknown":', e.message);
  }

  // 2. Uji autentikasi dengan dua metode
  const methods = ['mr-auth', 'x-api-key'];
  let authOk = false;

  for (const method of methods) {
    const testHeaders = {
      'X-Version': VERSION,
      'Content-Type': 'application/json',
    };
    if (method === 'mr-auth') {
      testHeaders['Authorization'] = `mr-auth ${rawKey}`;
    } else {
      testHeaders['X-API-Key'] = rawKey;
    }

    try {
      const res = await fetch(`${BASE}/accounts/me`, { headers: testHeaders });
      if (res.ok) {
        // Simpan headers yang berhasil
        HEADERS = { ...testHeaders };
        authOk = true;
        console.log(`✅ Autentikasi berhasil dengan metode: ${method}`);
        break;
      } else if (res.status === 401) {
        console.warn(`❌ Metode ${method} gagal (401 Unauthorized)`);
      } else {
        console.warn(`⚠️ Metode ${method} mendapat status ${res.status}`);
      }
    } catch (err) {
      console.warn(`⚠️ Metode ${method} error: ${err.message}`);
    }
  }

  if (!authOk) {
    console.error('❌ Semua metode autentikasi gagal. Pastikan API_KEY valid.');
    console.error('Format API key: mr_live_xxxx (mulai dengan mr_live_)');
    process.exit(1);
  }
}

// ... kode selanjutnya (main, joinFree, dll) tetap sama ...

// Jalankan
init().then(() => {
  const port = process.env.PORT || 3000;
  startDashboard(port);
  dashboardState.addLog('system', 'Bot started');
  main();
});