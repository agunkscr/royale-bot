import fetch from 'node-fetch';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

const getHeaders = () => ({
  'Authorization': `Bearer ${config.apiKey}`,
  'X-Version': config.version,
  'Content-Type': 'application/json',
});

export async function fetchVersion() {
  try {
    const res = await fetch(`${config.apiBase}/version`, { headers: getHeaders() });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    logger.info(`API version: ${data.version || 'unknown'}`);
    return data;
  } catch (err) {
    logger.error('Failed to fetch version:', err.message);
    return null;
  }
}

export async function getAccount() {
  try {
    const res = await fetch(`${config.apiBase}/accounts/me`, { headers: getHeaders() });
    if (res.status === 426) {
      logger.warn('Version mismatch, update X-Version header');
      return null;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return data;
  } catch (err) {
    logger.error('Failed to fetch account:', err.message);
    return null;
  }
}

export async function registerIdentity(tokenId) {
  try {
    const res = await fetch(`${config.apiBase}/identity`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({ agentId: tokenId }),
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
