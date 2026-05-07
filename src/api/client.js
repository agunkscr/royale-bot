const fetch = require('node-fetch');
const config = require('../config');
const logger = require('../utils/logger');

const headers = {
  'Authorization': `Bearer ${config.apiKey}`,
  'X-Version': config.version,
  'Content-Type': 'application/json',
};

async function getAccountStatus() {
  try {
    const res = await fetch(`${config.apiBaseUrl}/accounts/me`, { headers });
    if (res.status === 426) {
      logger.warn('Version mismatch, update X-Version header');
      return null;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return data;
  } catch (err) {
    logger.error('Failed to fetch account status:', err.message);
    return null;
  }
}

async function registerIdentity(agentId) {
  try {
    const res = await fetch(`${config.apiBaseUrl}/api/identity`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ agentId }), // agentId = tokenId dari NFT ERC-8004
    });
    if (res.status === 426) throw new Error('Version mismatch');
    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.message || `HTTP ${res.status}`);
    }
    return await res.json();
  } catch (err) {
    logger.error('Identity registration failed:', err.message);
    return null;
  }
}

module.exports = { getAccountStatus, registerIdentity };