const logger = require('../utils/logger');

/**
 * Berdasarkan status akun, tentukan state dan aksi yang diperlukan.
 * Returns { state, action, data? }
 */
function determineState(account) {
  if (!account) {
    return { state: 'ERROR', action: 'retry_fetch' };
  }

  // NO_ACCOUNT: jika tidak ada kredensial / API key
  // Di sini kita asumsikan API key sudah ada, jadi tidak perlu create account.
  // Tapi jika akun tidak ditemukan (misal 404), kita anggap NO_ACCOUNT.
  if (!account.id) {
    // fallback, anggap akun tidak ada
    logger.error('Akun tidak ditemukan - API key tidak valid?');
    return { state: 'ERROR', action: 'invalid_credentials' };
  }

  const { readiness, currentGames } = account;

  // NO_IDENTITY: erc8004Id null dan tidak ada game
  if (!readiness.erc8004Id && (!currentGames || currentGames.length === 0)) {
    return { state: 'NO_IDENTITY', action: 'register_identity' };
  }

  // IN_GAME: ada game aktif
  if (currentGames && currentGames.length > 0) {
    return { state: 'IN_GAME', action: 'play_game', game: currentGames[0] };
  }

  // READY_PAID: paidReady true (dan tidak in game)
  if (readiness.paidReady) {
    return { state: 'READY_PAID', action: 'join_paid' };
  }

  // READY_FREE: selain itu, asumsikan siap free
  return { state: 'READY_FREE', action: 'join_free' };
}

module.exports = { determineState };