require('dotenv').config();

module.exports = {
  apiKey: process.env.API_KEY,
  entryMode: process.env.ENTRY_MODE || 'free',   // free / paid
  paymentMode: process.env.PAYMENT_MODE || 'offchain', // offchain / onchain
  logLevel: process.env.LOG_LEVEL || 'info',
  pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS, 10) || 10000,
  wsJoinUrl: 'wss://cdn.moltyroyale.com/ws/join',
  wsAgentUrl: 'wss://cdn.moltyroyale.com/ws/agent',
  apiBaseUrl: 'https://cdn.moltyroyale.com/api',
  version: '1', // bisa diambil dari /api/version, tapi hardcode dulu
};