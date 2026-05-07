const WebSocket = require('ws');
const config = require('../config');
const logger = require('../utils/logger');
const GameHandler = require('../game/handler');

class WebSocketManager {
  constructor() {
    this.socket = null;
    this.handler = null;
    this.reconnectAttempts = 0;
    this.maxReconnectDelay = 30000; // 30 detik
    this.currentState = null; // 'join' atau 'gameplay'
    this.onGameOver = null;   // callback ketika game selesai
  }

  connectJoin() {
    this.currentState = 'join';
    this.reconnectAttempts = 0;
    this._openSocket(config.wsJoinUrl, true);
  }

  connectGame() {
    // Jika masih ada socket terbuka dan merupakan gameplay socket, gunakan kembali
    if (this.socket && this.socket.readyState === WebSocket.OPEN && this.currentState === 'gameplay') {
      logger.info('Game socket already active');
      return;
    }
    this.currentState = 'gameplay';
    this.reconnectAttempts = 0;
    // Untuk reconnect, gunakan endpoint agent, tapi harus kirim hello/resume? 
    // Menurut doc, reconnect cukup buka /ws/agent dengan auth yang sama.
    // Tapi lebih aman kita gunakan join socket ulang? 
    // Kita akan implementasi: jika IN_GAME, buka /ws/agent, kirim auth, lalu handshake.
    // Namun doc menyebutkan: "If you have an active game and your connection drops, reconnect by opening a new connection to /ws/agent using your credentials."
    this._openSocket(config.wsAgentUrl, false);
  }

  _openSocket(url, isJoin) {
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }

    const headers = {
      'Authorization': `Bearer ${config.apiKey}`,
      'X-Version': config.version,
    };

    const ws = new WebSocket(url, { headers });
    this.socket = ws;

    ws.on('open', () => {
      logger.info(`WebSocket connected to ${url}`);
      this.reconnectAttempts = 0;
      if (!isJoin) {
        // Langsung assign handler gameplay (kita tunggu data dari server)
        // Handler akan dibuat di on('message') pertama jika belum ada.
      }
    });

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data);
        if (isJoin) {
          this._handleJoinMessage(msg, ws);
        } else {
          // Gameplay socket (reconnect)
          if (!this.handler) {
            // Mungkin server mengirim welcome ulang? Kita perlu cek
            if (msg.type === 'agent_view' || msg.type === 'turn_advanced') {
              this.handler = new GameHandler((payload) => {
                this.socket.send(JSON.stringify(payload));
              });
            }
          }
          if (this.handler) {
            this.handler.handleMessage(data);
          } else {
            logger.debug('Waiting for game state...');
          }
        }
      } catch (e) {
        logger.error('Failed to parse message:', e);
      }
    });

    ws.on('close', (code) => {
      logger.warn(`WebSocket closed (code ${code})`);
      if (this.handler) {
        this.handler.cleanup();
        this.handler = null;
      }
      if (this.currentState === 'gameplay' && !this.handler?.gameOver) {
        this._scheduleReconnect();
      }
    });

    ws.on('error', (err) => {
      logger.error('WebSocket error:', err.message);
      ws.close(); // akan memicu close
    });
  }

  _handleJoinMessage(msg, ws) {
    switch (msg.type) {
      case 'welcome':
        logger.info('Received welcome, sending hello');
        const entryType = config.entryMode === 'paid' ? 'paid' : 'free';
        const helloPayload = { type: 'hello', entryType };
        if (entryType === 'paid' && config.paymentMode === 'offchain') {
          helloPayload.mode = 'offchain';
        }
        ws.send(JSON.stringify(helloPayload));
        break;

      case 'assigned':
      case 'joined':
        logger.info(`Game ${msg.type}! GameID: ${msg.gameId}`);
        this.currentState = 'gameplay';
        this.handler = new GameHandler((payload) => {
          this.socket.send(JSON.stringify(payload));
        });
        // Sekarang socket ini menerima gameplay messages
        break;

      case 'error':
        logger.error('Join error:', msg.message);
        break;

      // setelah assigned/joined, pesan game akan masuk ke sini juga
      default:
        if (this.handler) {
          this.handler.handleMessage(JSON.stringify(msg));
        } else if (msg.type === 'agent_view' || msg.type === 'turn_advanced') {
          // case saat reconnect tanpa handler
          this.currentState = 'gameplay';
          this.handler = new GameHandler((payload) => this.socket.send(JSON.stringify(payload)));
          this.handler.handleMessage(JSON.stringify(msg));
        }
    }
  }

  _scheduleReconnect() {
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), this.maxReconnectDelay);
    this.reconnectAttempts++;
    logger.info(`Reconnecting in ${delay / 1000}s...`);
    setTimeout(() => {
      if (this.currentState === 'gameplay') {
        this.connectGame();
      } else {
        this.connectJoin();
      }
    }, delay);
  }

  isActive() {
    return this.socket && this.socket.readyState === WebSocket.OPEN;
  }

  disconnect() {
    if (this.handler) this.handler.cleanup();
    if (this.socket) this.socket.close();
    this.handler = null;
    this.socket = null;
  }
}

module.exports = WebSocketManager;