import WebSocket from 'ws';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { GameHandler } from '../game/handler.js';

export class WebSocketManager {
  constructor() {
    this.ws = null;
    this.handler = null;
    this.currentRole = null;
    this.reconnectTimer = null;
    this.attempt = 0;
  }

  connectJoin(entryType = 'free') {
    this._connect(config.wsJoin, 'join', entryType);
  }

  connectGame() {
    this._connect(config.wsAgent, 'game');
  }

  _connect(url, role, entryType = null) {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.currentRole = role;
    this.ws = new WebSocket(url, {
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'X-Version': config.version,
      },
    });

    this.ws.on('open', () => {
      logger.info(`WS connected to ${url} (${role})`);
      this.attempt = 0;
    });

    this.ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (role === 'join') {
          this._handleJoinMessage(msg, entryType);
        } else {
          if (!this.handler) {
            this.handler = new GameHandler((payload) => this.send(payload));
          }
          this.handler.handleMessage(data.toString());
        }
      } catch (e) {
        logger.error('WS message error:', e);
      }
    });

    this.ws.on('close', (code) => {
      logger.warn(`WS closed (${code})`);
      if (this.handler) {
        this.handler.cleanup();
        this.handler = null;
      }
      if (role === 'game') {
        this._scheduleReconnect(() => this.connectGame());
      } else {
        this._scheduleReconnect(() => this.connectJoin(entryType));
      }
    });

    this.ws.on('error', (e) => logger.error('WS error:', e.message));
  }

  _handleJoinMessage(msg, entryType) {
    switch (msg.type) {
      case 'welcome':
        logger.info('Received welcome, sending hello');
        const hello = { type: 'hello', entryType };
        if (entryType === 'paid') hello.mode = 'offchain';
        this.ws.send(JSON.stringify(hello));
        break;
      case 'assigned':
      case 'joined':
        logger.info(`Game ${msg.type}! ID: ${msg.gameId}`);
        this.currentRole = 'game';
        this.handler = new GameHandler((payload) => this.send(payload));
        break;
      case 'error':
        logger.error('Join error:', msg.message);
        break;
      default:
        if (this.handler) {
          this.handler.handleMessage(JSON.stringify(msg));
        } else if (msg.type === 'agent_view' || msg.type === 'turn_advanced') {
          this.currentRole = 'game';
          this.handler = new GameHandler((payload) => this.send(payload));
          this.handler.handleMessage(JSON.stringify(msg));
        }
    }
  }

  send(payload) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    }
  }

  _scheduleReconnect(callback) {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    const delay = Math.min(1000 * Math.pow(2, this.attempt), 30000);
    this.attempt++;
    logger.info(`Reconnecting in ${delay / 1000}s...`);
    this.reconnectTimer = setTimeout(callback, delay);
  }

  isActive() {
    return this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  disconnect() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.handler) this.handler.cleanup();
    if (this.ws) this.ws.close();
    this.handler = null;
    this.ws = null;
  }
}