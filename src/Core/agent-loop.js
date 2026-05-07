const { getAccountStatus, registerIdentity } = require('../api/client');
const { determineState } = require('./state-machine');
const WebSocketManager = require('./websocket');
const config = require('../config');
const logger = require('../utils/logger');

class AgentLoop {
  constructor() {
    this.wsm = new WebSocketManager();
    this.state = 'INIT';
    this.interval = null;
  }

  start() {
    logger.info('Agent loop started');
    this._tick(); // langsung cek
    this.interval = setInterval(() => this._tick(), config.pollIntervalMs);
  }

  stop() {
    if (this.interval) clearInterval(this.interval);
    this.wsm.disconnect();
  }

  async _tick() {
    try {
      const account = await getAccountStatus();
      if (!account) {
        logger.warn('Tidak bisa mendapatkan status akun, coba lagi nanti');
        return;
      }

      const { state, action, game } = determineState(account);
      logger.info(`State: ${state}, Action: ${action}`);

      // Jika sudah terhubung ke game dan state masih IN_GAME, tidak perlu buka koneksi baru
      if (state === 'IN_GAME' && this.wsm.isActive() && this.wsm.currentState === 'gameplay') {
        logger.debug('Sudah dalam game, koneksi aktif');
        return;
      }

      // Jika tidak dalam game, tutup koneksi game jika ada
      if (state !== 'IN_GAME' && this.wsm.currentState === 'gameplay') {
        this.wsm.disconnect();
      }

      switch (state) {
        case 'NO_IDENTITY':
          await this._handleIdentity(account);
          break;
        case 'READY_FREE':
        case 'READY_PAID':
          this.wsm.connectJoin();
          break;
        case 'IN_GAME':
          if (!this.wsm.isActive()) {
            this.wsm.connectGame();
          }
          break;
        case 'ERROR':
          logger.error('Error state, waiting for next tick');
          break;
        default:
          break;
      }
    } catch (err) {
      logger.error('Unhandled error in agent loop:', err);
    }
  }

  async _handleIdentity(account) {
    // Untuk free room, perlu identitas ERC-8004.
    // Di sini kita asumsikan user sudah punya NFT tokenId (dari kontrak IdentityRegistry)
    // dan ingin mendaftarkan ke server.
    // Nilai tokenId bisa didapat dari environment atau kita minta input.
    const tokenId = process.env.ERC8004_TOKEN_ID;
    if (!tokenId) {
      logger.error('NO_IDENTITY tetapi ERC8004_TOKEN_ID tidak disetel di .env');
      return;
    }
    logger.info(`Mendaftarkan identitas ERC-8004 dengan tokenId ${tokenId}`);
    const result = await registerIdentity(tokenId);
    if (result) {
      logger.info('Pendaftaran identitas berhasil');
    }
  }
}

module.exports = AgentLoop;