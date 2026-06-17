export function activePlayers(manifest) {
  return (manifest.players ?? []).filter(player => player.enabled !== false);
}

export function selectedPlayers(players, selectedIds) {
  if (!selectedIds?.size) return players;
  return players.filter(player => selectedIds.has(player.id));
}
