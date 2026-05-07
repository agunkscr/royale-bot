import 'dotenv/config';

export const config = {
  apiKey: process.env.API_KEY,
  entryMode: process.env.ENTRY_MODE || 'free',
  paymentMode: process.env.PAYMENT_MODE || 'offchain',
  logLevel: process.env.LOG_LEVEL || 'info',
  pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS, 10) || 10000,
  erc8004TokenId: process.env.ERC8004_TOKEN_ID,
  walletPrivateKey: process.env.WALLET_PRIVATE_KEY,
  port: process.env.PORT || 3000,
  wsJoin: 'wss://cdn.moltyroyale.com/ws/join',
  wsAgent: 'wss://cdn.moltyroyale.com/ws/agent',
  apiBase: 'https://cdn.moltyroyale.com/api',
  version: '1.6.0',
};
