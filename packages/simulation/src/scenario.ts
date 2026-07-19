import { playerId } from './commands.js';
import {
  advanceTick,
  applyCommand,
  createWorld,
  inspectWorld,
  joinPlayer,
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
export const runBotScenario = (playerCount: number, ticks: number): ScenarioResult => {
  const state = createWorld(20260719);
  const sequence = new Map<string, number>();
  let commandCount = 0;
  const issue = (player: string, command: Record<string, unknown>) => {
    const next = (sequence.get(player) ?? 0) + 1;
    sequence.set(player, next);
    commandCount += 1;
    applyCommand(state, {
      id: `${player}-${next}`,
      playerId: playerId(player),
      sequence: next,
      ...command,
    } as never);
  };
  for (let index = 0; index < playerCount; index += 1) {
    const player = `bot-${index}`;
    joinPlayer(state, player);
    const playerState = state.players[player]!;
    playerState.inventory.wood = 7;
    const buildTiles = Array.from({ length: playerState.plot.size }, (_, x) =>
      Array.from({ length: playerState.plot.size }, (_, y) => ({
        x: playerState.plot.x + x,
        y: playerState.plot.y + y,
      })),
    )
      .flat()
      .filter((tile) => terrainAt(state.seed, tile.x, tile.y) !== 'water');
    const [smelter, storage, tower] = buildTiles;
    if (!smelter || !storage || !tower)
      throw new Error(`No safe bot construction plot for ${player}`);
    issue(player, { type: 'placeSmelter', ...smelter });
    issue(player, { type: 'placeStorage', ...storage });
    issue(player, { type: 'placeWatchtower', ...tower });
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
          issue(player, {
            type: 'createLogisticsLink',
            sourceBuildingId: storage.id,
            targetBuildingId: smelter.id,
            item: 'ore',
          });
      }
    if (tick % 5 === 0)
      for (const player of Object.keys(state.players)) {
        const plot = state.players[player]!.plot;
        issue(player, { type: 'gather', x: plot.x, y: plot.y });
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
      }
    advanceTick(state);
  }
  return { state, hash: stateHash(state), commandCount, invariantErrors: inspectWorld(state) };
};
