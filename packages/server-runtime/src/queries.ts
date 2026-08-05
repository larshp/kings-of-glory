import type { DirectoryPage, TerrainTile, WorldMapPage } from '@kings/protocol';
import { CHUNK_SIZE, chunkKeyFor, terrainAt, type WorldState } from '@kings/simulation';

const parseChunkKey = (key: string) => {
  const [xText, yText] = key.split(':');
  return { x: Number(xText), y: Number(yText) };
};

/** Builds a bounded strategic view without exposing entities in historically explored fog. */
export const worldMapPageFor = (
  state: WorldState,
  playerId: string,
  after: string | undefined,
  limit: number,
): WorldMapPage => {
  const player = state.players[playerId];
  if (!player) return { ...(after ? { after } : {}), chunks: [], totalExploredChunks: 0 };
  const explored = Object.keys(player.exploredChunks)
    .map((key) => ({ key, ...parseChunkKey(key) }))
    .sort((left, right) => left.x - right.x || left.y - right.y);
  const afterIndex = after ? explored.findIndex(({ key }) => key === after) : -1;
  const start = afterIndex >= 0 ? afterIndex + 1 : 0;
  const selected = explored.slice(start, start + limit);
  const territory = new Map<string, string>();
  for (const owner of Object.values(state.players))
    for (const sector of Object.keys(owner.territoryCells)) territory.set(sector, owner.id);
  const chunks = selected.map(({ x: chunkX, y: chunkY }) => {
    const currentlyVisible = Boolean(player.visibleChunks?.[`${chunkX}:${chunkY}`]);
    const terrain: Record<TerrainTile, number> = {
      grass: 0,
      water: 0,
      ore: 0,
      wood: 0,
      mountain: 0,
    };
    for (let localX = 0; localX < CHUNK_SIZE; localX += 1)
      for (let localY = 0; localY < CHUNK_SIZE; localY += 1)
        terrain[
          terrainAt(state.seed, chunkX * CHUNK_SIZE + localX, chunkY * CHUNK_SIZE + localY)
        ] += 1;
    const buildings = Object.values(state.buildings).filter(
      (building) => chunkKeyFor(building.x, building.y) === `${chunkX}:${chunkY}`,
    );
    const ownerCounts = new Map<string, number>();
    for (let sectorX = chunkX * 2; sectorX < chunkX * 2 + 2; sectorX += 1)
      for (let sectorY = chunkY * 2; sectorY < chunkY * 2 + 2; sectorY += 1) {
        const ownerId = territory.get(`${sectorX}:${sectorY}`);
        if (ownerId) ownerCounts.set(ownerId, (ownerCounts.get(ownerId) ?? 0) + 1);
      }
    return {
      x: chunkX,
      y: chunkY,
      currentlyVisible,
      terrain,
      ownBuildingCount: buildings.filter((building) => building.ownerId === playerId).length,
      visibleForeignBuildingCount: currentlyVisible
        ? buildings.filter((building) => building.ownerId !== playerId).length
        : 0,
      visibleThreatCount: currentlyVisible
        ? Object.values(state.threats).filter(
            (threat) => chunkKeyFor(threat.x, threat.y) === `${chunkX}:${chunkY}`,
          ).length
        : 0,
      claimedSectors: [...ownerCounts]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([ownerId, count]) => ({ ownerId, count })),
    };
  });
  const nextCursor = start + selected.length < explored.length ? selected.at(-1)?.key : undefined;
  return {
    ...(after ? { after } : {}),
    chunks,
    ...(nextCursor ? { nextCursor } : {}),
    totalExploredChunks: explored.length,
  };
};

/** Public directory projection: identifiers and member counts only, never world position or state. */
export const directoryPageFor = (
  state: WorldState,
  query: string,
  after: string | undefined,
  limit: number,
): DirectoryPage => {
  const normalized = query.trim().toLocaleLowerCase('en-US');
  const entries = [
    ...Object.keys(state.players).map((playerId) => ({
      key: `player:${playerId}`,
      searchable: `${playerId} ${state.social.playerNames[playerId] ?? ''}`.toLocaleLowerCase(
        'en-US',
      ),
      entry: {
        type: 'player' as const,
        playerId,
        displayName: state.social.playerNames[playerId] ?? playerId,
      },
    })),
    ...Object.values(state.settlements).map((settlement) => ({
      key: `settlement:${settlement.id}`,
      searchable:
        `${settlement.id} ${settlement.ownerId} ${state.social.settlementNames[settlement.id] ?? ''}`.toLocaleLowerCase(
          'en-US',
        ),
      entry: {
        type: 'settlement' as const,
        settlementId: settlement.id,
        displayName: state.social.settlementNames[settlement.id] ?? settlement.id,
        ownerId: settlement.ownerId,
        memberCount: Object.keys(settlement.members).length,
      },
    })),
  ]
    .filter(({ searchable }) => !normalized || searchable.includes(normalized))
    .sort((left, right) => left.key.localeCompare(right.key));
  const afterIndex = after ? entries.findIndex(({ key }) => key === after) : -1;
  const start = afterIndex >= 0 ? afterIndex + 1 : 0;
  const selected = entries.slice(start, start + limit);
  const nextCursor = start + selected.length < entries.length ? selected.at(-1)?.key : undefined;
  return {
    query: normalized,
    ...(after ? { after } : {}),
    entries: selected.map(({ entry }) => entry),
    ...(nextCursor ? { nextCursor } : {}),
  };
};
