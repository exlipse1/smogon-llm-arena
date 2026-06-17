export function expectedScore(ratingA, ratingB) {
  return 1 / (1 + 10 ** ((ratingB - ratingA) / 400));
}

export function updateElo(ratingA, ratingB, scoreA, kFactor = 32) {
  const expectedA = expectedScore(ratingA, ratingB);
  const expectedB = 1 - expectedA;
  const scoreB = 1 - scoreA;
  return {
    a: ratingA + kFactor * (scoreA - expectedA),
    b: ratingB + kFactor * (scoreB - expectedB),
  };
}

export function resultToScore(result, playerId) {
  if (result.tie) return 0.5;
  return result.winnerId === playerId ? 1 : 0;
}
