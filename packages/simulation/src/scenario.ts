import { playerId } from './commands.js';
import {
  advanceTick,
  applyCommand,
  createWorld,
  inspectWorld,
  joinPlayer,
  nearestOreTile,
  stateHash,
  terrainAt,
  type WorldState,
} from './world.js';

export interface ScenarioResult {
  state: WorldState;
  hash: string;
  commandCount: number;
  invariantErrors: readonly string[];
}

/** Deterministic bot workload used by CI tests and the server load runner. */
export const runBotScenario = (
  playerCount: number,
  ticks: number,
  targetBuildingsPerPlayer = 5,
): ScenarioResult => {
  if (!Number.isInteger(targetBuildingsPerPlayer) || targetBuildingsPerPlayer < 5)
    throw new Error('Bot scenarios require at least five buildings per player.');
  const state = createWorld(20260719);
  const sequence = new Map<string, number>();
  const towerTiles = new Map<string, { x: number; y: number }>();
  const oreTiles = new Map<string, { x: number; y: number }>();
  let commandCount = 0;
  const issue = (player: string, command: Record<string, unknown>) => {
    const next = (sequence.get(player) ?? 0) + 1;
    sequence.set(player, next);
    commandCount += 1;
    return applyCommand(state, {
      id: `${player}-${next}`,
      playerId: playerId(player),
      sequence: next,
      ...command,
    } as never);
  };
  const requireIssue = (player: string, command: Record<string, unknown>) => {
    const outcome = issue(player, command);
    if (!outcome.result.accepted)
      throw new Error(
        `Scenario command ${String(command.type)} was rejected: ${outcome.result.code}`,
      );
  };
  for (let index = 0; index < playerCount; index += 1) {
    const player = `bot-${index}`;
    joinPlayer(state, player);
    const playerState = state.players[player]!;
    // Covers the whole ore -> ingot -> tool chain after constructing the basic settlement.
    playerState.inventory.wood = 14 + (targetBuildingsPerPlayer - 5) * 2;
    playerState.inventory.ingot = 1;
    const buildTiles = Array.from({ length: playerState.plot.size }, (_, x) =>
      Array.from({ length: playerState.plot.size }, (_, y) => ({
        x: playerState.plot.x + x,
        y: playerState.plot.y + y,
      })),
    )
      .flat()
      .filter(
        (tile) =>
          terrainAt(state.seed, tile.x, tile.y) !== 'water' &&
          (tile.x !== playerState.plot.x + playerState.plot.size - 2 ||
            tile.y !== playerState.plot.y + playerState.plot.size - 2),
      );
    const [smelter, storage, tower, workshop] = buildTiles;
    if (!smelter || !storage || !tower || !workshop)
      throw new Error(`No safe bot construction plot for ${player}`);
    requireIssue(player, { type: 'placeSmelter', ...smelter });
    requireIssue(player, { type: 'placeStorage', ...storage });
    for (const tile of buildTiles.slice(4, targetBuildingsPerPlayer - 1))
      requireIssue(player, { type: 'placeStorage', ...tile });
    requireIssue(player, { type: 'research', technologyId: 'metallurgy' });
    towerTiles.set(player, tower);
    towerTiles.set(`${player}:workshop`, workshop);
    const oreTile = nearestOreTile(
      state.seed,
      playerState.plot.x + Math.floor(playerState.plot.size / 2),
      playerState.plot.y + Math.floor(playerState.plot.size / 2),
      8,
    );
    if (!oreTile) throw new Error(`No reachable ore deposit for ${player}`);
    oreTiles.set(player, oreTile);
  }
  for (let tick = 0; tick < ticks; tick += 1) {
    if (tick === 10)
      for (const player of Object.keys(state.players)) {
        const smelter = Object.values(state.buildings).find(
          (building) => building.ownerId === player && building.kind === 'smelter',
        );
        const storage = Object.values(state.buildings).find(
          (building) => building.ownerId === player && building.kind === 'storage',
        );
        if (
          smelter &&
          storage &&
          smelter.constructionTicks === 0 &&
          storage.constructionTicks === 0
        )
          requireIssue(player, {
            type: 'createLogisticsLink',
            sourceBuildingId: storage.id,
            targetBuildingId: smelter.id,
            item: 'ore',
          });
        const tower = towerTiles.get(player);
        if (tower) requireIssue(player, { type: 'placeWatchtower', ...tower });
        const workshopTile = towerTiles.get(`${player}:workshop`);
        if (workshopTile) requireIssue(player, { type: 'placeWorkshop', ...workshopTile });
      }
    if (tick === 20)
      for (const player of Object.keys(state.players)) {
        const smelter = Object.values(state.buildings).find(
          (building) => building.ownerId === player && building.kind === 'smelter',
        );
        const storage = Object.values(state.buildings).find(
          (building) => building.ownerId === player && building.kind === 'storage',
        );
        const workshop = Object.values(state.buildings).find(
          (building) => building.ownerId === player && building.kind === 'workshop',
        );
        if (!smelter || !storage || !workshop)
          throw new Error(`Missing completed bot production chain for ${player}`);
        if (
          smelter.constructionTicks === 0 &&
          storage.constructionTicks === 0 &&
          workshop.constructionTicks === 0
        ) {
          requireIssue(player, {
            type: 'createLogisticsLink',
            sourceBuildingId: smelter.id,
            targetBuildingId: workshop.id,
            item: 'ingot',
          });
          requireIssue(player, {
            type: 'createLogisticsLink',
            sourceBuildingId: storage.id,
            targetBuildingId: workshop.id,
            item: 'wood',
          });
        }
      }
    if (tick % 5 === 0)
      for (const player of Object.keys(state.players)) {
        const oreTile = oreTiles.get(player);
        if (!oreTile) throw new Error(`No ore deposit registered for ${player}`);
        issue(player, { type: 'gather', ...oreTile });
        const storage = Object.values(state.buildings).find(
          (building) => building.ownerId === player && building.kind === 'storage',
        );
        if (storage && storage.constructionTicks === 0 && state.players[player]!.inventory.ore > 0)
          issue(player, {
            type: 'transfer',
            buildingId: storage.id,
            item: 'ore',
            amount: 1,
            direction: 'toBuilding',
          });
        if (storage && storage.constructionTicks === 0 && state.players[player]!.inventory.wood > 0)
          issue(player, {
            type: 'transfer',
            buildingId: storage.id,
            item: 'wood',
            amount: 1,
            direction: 'toBuilding',
          });
      }
    advanceTick(state);
  }
  return { state, hash: stateHash(state), commandCount, invariantErrors: inspectWorld(state) };
};
