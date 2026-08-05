import { buildingId, playerId } from './commands.js';
import { deserializeWorld } from './migrations.js';
import {
  advanceTick,
  applyCommand,
  createWorld,
  emptyInventory,
  inspectWorld,
  isOpenTile,
  joinPlayer,
  logisticsCarrierCapacity,
  logisticsRouteFor,
  nearestOreTile,
  stateHash,
  type Building,
  type LogisticsLink,
  type TickPhase,
  type WorldState,
} from './world.js';

export type BotActionKind =
  'gather' | 'build' | 'research' | 'trade' | 'expand' | 'reconnect' | 'defend';

export interface ScenarioResult {
  state: WorldState;
  hash: string;
  commandCount: number;
  invariantErrors: readonly string[];
  botActions: Readonly<Record<BotActionKind, number>>;
}

export interface PhaseProfile {
  ticks: number;
  phaseDurationsMs: Readonly<Record<TickPhase, number>>;
  result: ScenarioResult;
}

export interface BotWorkloadOptions {
  readonly playerCount: number;
  readonly targetBuildingsPerPlayer?: number;
  /** Rebuilds world state from its own snapshot after the given zero-based tick. */
  readonly reconnectAfterTick?: (tick: number) => boolean;
  /**
   * Issues one always-valid command per player per tick. Long runs need it so the
   * accepted-command path, activity tracking, and the idempotency window stay
   * exercised after the starter deposits are exhausted.
   */
  readonly keepPlayersActive?: boolean;
}

/**
 * A resumable bot workload. Batch scenarios drive it to a tick count; the soak
 * runner drives it against a wall clock for as long as the run lasts.
 */
export interface BotWorkload {
  readonly state: WorldState;
  readonly tick: number;
  readonly commandCount: number;
  readonly botActions: Readonly<Record<BotActionKind, number>>;
  /** Issues the commands due this tick, advances the simulation, and reconnects when asked. */
  step(): void;
  result(): ScenarioResult;
}

/** Deterministic bot workload used by CI tests and the server load runner. */
export const runBotScenario = (
  playerCount: number,
  ticks: number,
  targetBuildingsPerPlayer = 5,
): ScenarioResult => {
  const workload = createBotWorkload({
    playerCount,
    targetBuildingsPerPlayer,
    reconnectAfterTick: (tick) => ticks > 1 && tick === Math.floor(ticks / 2),
  });
  for (let tick = 0; tick < ticks; tick += 1) workload.step();
  return workload.result();
};

export const createBotWorkload = ({
  playerCount,
  targetBuildingsPerPlayer = 5,
  reconnectAfterTick,
  keepPlayersActive = false,
}: BotWorkloadOptions): BotWorkload => {
  if (!Number.isInteger(targetBuildingsPerPlayer) || targetBuildingsPerPlayer < 5)
    throw new Error('Bot scenarios require at least five buildings per player.');
  let state = createWorld(20260719, false);
  const sequence = new Map<string, number>();
  const towerTiles = new Map<string, { x: number; y: number }>();
  const oreTiles = new Map<string, { x: number; y: number }>();
  let commandCount = 0;
  const botActions: Record<BotActionKind, number> = {
    gather: 0,
    build: 0,
    research: 0,
    trade: 0,
    expand: 0,
    reconnect: 0,
    defend: 0,
  };
  const issue = (player: string, command: Record<string, unknown>) => {
    const next = (sequence.get(player) ?? 0) + 1;
    sequence.set(player, next);
    commandCount += 1;
    const outcome = applyCommand(state, {
      id: `${player}-${next}`,
      playerId: playerId(player),
      sequence: next,
      ...command,
    } as never);
    if (outcome.result.accepted) {
      const type = String(command.type);
      if (type === 'gather') botActions.gather += 1;
      else if (type.startsWith('place')) botActions.build += 1;
      else if (type === 'research') botActions.research += 1;
      else if (type === 'transferToPlayer') botActions.trade += 1;
      else if (type === 'claimTerritory') botActions.expand += 1;
      else if (type === 'repair') botActions.defend += 1;
    }
    return outcome;
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
    // Keep a repair reserve after the density fixture funds all construction;
    // otherwise the target-size load can silently skip its threat-response path.
    playerState.inventory.wood = 25 + (targetBuildingsPerPlayer - 5) * 2;
    playerState.inventory.ingot = 1;
    // This is a density fixture rather than a starter-settlement scenario: give
    // it enough abstract construction labor to exercise production and combat
    // instead of spending the entire run serializing 50 build projects.
    playerState.population.total = targetBuildingsPerPlayer;
    const buildTiles = Array.from({ length: playerState.plot.size }, (_, x) =>
      Array.from({ length: playerState.plot.size }, (_, y) => ({
        x: playerState.plot.x + x,
        y: playerState.plot.y + y,
      })),
    )
      .flat()
      .filter(
        (tile) =>
          isOpenTile(state.seed, tile.x, tile.y) &&
          !(
            tile.y === playerState.plot.y + playerState.plot.size - 2 &&
            tile.x < playerState.plot.x + playerState.plot.size - 2
          ) &&
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
  let tick = 0;
  const step = () => {
    if (tick === 1 && playerCount > 1)
      requireIssue('bot-0', {
        type: 'transferToPlayer',
        targetPlayerId: playerId('bot-1'),
        item: 'wood',
        amount: 1,
      });
    if (tick === 20) for (const player of Object.values(state.players)) player.population.total = 2;
    if (tick === 20)
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
    if (tick === 40)
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
        if (storage && storage.constructionTicks === 0 && state.players[player]!.inventory.wood > 5)
          issue(player, {
            type: 'transfer',
            buildingId: storage.id,
            item: 'wood',
            amount: 1,
            direction: 'toBuilding',
          });
      }
    for (const player of Object.keys(state.players)) {
      const playerState = state.players[player]!;
      if (
        playerState.research.unlocked.metallurgy &&
        !playerState.research.unlocked['territorial-charter'] &&
        playerState.research.activeTechnology === null
      ) {
        const workshop = Object.values(state.buildings).find(
          (building) => building.ownerId === player && building.kind === 'workshop',
        );
        const neededTools = 2 - playerState.inventory.tool;
        if (workshop && neededTools > 0 && workshop.inventory.tool > 0)
          issue(player, {
            type: 'transfer',
            buildingId: workshop.id,
            item: 'tool',
            amount: Math.min(neededTools, workshop.inventory.tool),
            direction: 'toPlayer',
          });
        if (playerState.inventory.tool >= 2)
          requireIssue(player, { type: 'research', technologyId: 'territorial-charter' });
      }
    }
    const firstBot = state.players['bot-0'];
    if (firstBot?.research.unlocked['territorial-charter'] && botActions.expand === 0) {
      const candidates = new Set<string>();
      for (const key of Object.keys(firstBot.territoryCells)) {
        const [xText, yText] = key.split(':');
        const cellX = Number(xText);
        const cellY = Number(yText);
        for (const [offsetX, offsetY] of [
          [1, 0],
          [0, 1],
          [-1, 0],
          [0, -1],
        ] as const)
          candidates.add(`${cellX + offsetX}:${cellY + offsetY}`);
      }
      for (const key of [...candidates].sort((left, right) => right.localeCompare(left))) {
        if (Object.values(state.players).some((candidate) => candidate.territoryCells[key]))
          continue;
        const [xText, yText] = key.split(':');
        const x = Number(xText) * 8;
        const y = Number(yText) * 8;
        issue('bot-0', { type: 'explore', x, y });
        if (issue('bot-0', { type: 'claimTerritory', x, y }).result.accepted) break;
      }
    }
    for (const target of Object.values(state.buildings))
      if (target.health < target.maxHealth)
        requireIssue(target.ownerId, { type: 'repair', buildingId: target.id });
    if (keepPlayersActive)
      for (const player of Object.keys(state.players)) {
        const playerState = state.players[player]!;
        requireIssue(player, {
          type: 'explore',
          x: playerState.plot.x + (tick % playerState.plot.size),
          y: playerState.plot.y,
        });
      }
    advanceTick(state);
    if (reconnectAfterTick?.(tick)) {
      state = deserializeWorld(state);
      botActions.reconnect += Object.keys(state.players).length;
    }
    tick += 1;
  };
  return {
    get state() {
      return state;
    },
    get tick() {
      return tick;
    },
    get commandCount() {
      return commandCount;
    },
    get botActions() {
      return botActions;
    },
    step,
    result: () => ({
      state,
      hash: stateHash(state),
      commandCount,
      invariantErrors: inspectWorld(state),
      botActions,
    }),
  };
};

/**
 * A dense, headless logistics workload. It intentionally uses direct fixture
 * construction so one scenario can exercise thousands of completed entities
 * without being constrained by a player's starter plot.
 */
const createInfrastructureStressState = (pairCount: number): WorldState => {
  if (!Number.isSafeInteger(pairCount) || pairCount < 1_000)
    throw new Error(
      'Infrastructure stress scenarios require at least 1,000 source/producer pairs.',
    );
  const state = createWorld(20260720);
  const ownerId = playerId('stress-owner');
  joinPlayer(state, ownerId);
  const center = state.buildings['center-stress-owner']!;
  for (let index = 0; index < pairCount; index += 1) {
    const sourceId = `stress-storage-${index}`;
    const targetId = `stress-smelter-${index}`;
    const source: Building = {
      ...center,
      id: buildingId(sourceId),
      kind: 'storage',
      x: index * 2,
      y: 0,
      inventory: { ...emptyInventory(), ore: 1 },
      inventoryCapacity: 200,
      populationCapacity: 0,
      jobPriority: 0,
      recipeId: null,
      productionState: 'idle',
    };
    const target: Building = {
      ...source,
      id: buildingId(targetId),
      kind: 'smelter',
      x: index * 2 + 1,
      maxHealth: 10,
      health: 10,
      inventory: emptyInventory(),
      inventoryCapacity: 20,
      jobPriority: 0,
      recipeId: 'smelt-ore',
    };
    // Routes come from the same planner the create-link command uses, because this fixture
    // stands in for a world where every link was already established.
    const route = logisticsRouteFor(state, source, target);
    const link: LogisticsLink = {
      id: `stress-link-${index}`,
      ownerId,
      sourceBuildingId: source.id,
      targetBuildingId: target.id,
      item: 'ore',
      priority: index % 4 === 0 ? 3 : 1,
      capacityPerTrip: logisticsCarrierCapacity,
      carrierId: `carrier-stress-link-${index}`,
      route,
      routeDistance: route.length / 2,
      status: 'idle',
    };
    state.buildings[sourceId] = source;
    state.buildings[targetId] = target;
    state.logisticsLinks[link.id] = link;
  }
  return state;
};

const requireStressTicks = (ticks: number) => {
  if (!Number.isSafeInteger(ticks) || ticks < 1)
    throw new Error('Infrastructure stress scenarios require at least one tick.');
};

export const runInfrastructureStressScenario = (pairCount = 1_000, ticks = 4): ScenarioResult => {
  requireStressTicks(ticks);
  const state = createInfrastructureStressState(pairCount);
  for (let tick = 0; tick < ticks; tick += 1) advanceTick(state);
  return {
    state,
    hash: stateHash(state),
    commandCount: 0,
    invariantErrors: inspectWorld(state),
    botActions: {
      gather: 0,
      build: 0,
      research: 0,
      trade: 0,
      expand: 0,
      reconnect: 0,
      defend: 0,
    },
  };
};

/** Runs the dense scenario with opt-in timings for every authoritative tick phase. */
export const profileInfrastructureStressScenario = (
  now: () => number,
  pairCount = 1_000,
  ticks = 4,
): PhaseProfile => {
  requireStressTicks(ticks);
  const state = createInfrastructureStressState(pairCount);
  const phaseDurationsMs: Record<TickPhase, number> = {
    'advance-clock': 0,
    'research-and-population': 0,
    'construction-and-production': 0,
    'environmental-events': 0,
    logistics: 0,
    'threat-spawning': 0,
    'threat-navigation-and-combat': 0,
    'emit-events-and-mark-changes': 0,
  };
  for (let tick = 0; tick < ticks; tick += 1)
    advanceTick(state, {
      now,
      record: (phase, durationMs) => {
        phaseDurationsMs[phase] += durationMs;
      },
    });
  return {
    ticks,
    phaseDurationsMs,
    result: {
      state,
      hash: stateHash(state),
      commandCount: 0,
      invariantErrors: inspectWorld(state),
      botActions: {
        gather: 0,
        build: 0,
        research: 0,
        trade: 0,
        expand: 0,
        reconnect: 0,
        defend: 0,
      },
    },
  };
};
