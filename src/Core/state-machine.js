export function determineState(account) {
  if (!account || !account.id) return { state: 'ERROR', action: 'invalid_account' };

  const { readiness, currentGames } = account;

  if (!readiness.erc8004Id && (!currentGames || currentGames.length === 0)) {
    return { state: 'NO_IDENTITY', action: 'register_identity' };
  }

  if (currentGames && currentGames.length > 0) {
    return { state: 'IN_GAME', action: 'play_game', game: currentGames[0] };
  }

  if (readiness.paidReady) {
    return { state: 'READY_PAID', action: 'join_paid' };
  }

  return { state: 'READY_FREE', action: 'join_free' };
}