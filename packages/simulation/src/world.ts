import {
  buildingId,
  type BuildingId,
  type Command,
  type CommandResult,
  playerId,
  type PlayerId,
  type SettlementRole,
} from './commands.js';
import {
  buildings as buildingDefinitions,
  environmentalEvents,
  logisticsLinks as logisticsDefinitions,
  producers as producerDefinitions,
  resources as resourceDefinitions,
  recipes,
  technologies,
  threats as threatDefinitions,
  type TechnologyId,
} from '@kings/content';
import { chunkFor, findHierarchicalPath, findPath, manhattanDistance } from '@kings/pathfinding';
import { stableHash } from './hash.js';
import { createRandomState, takeRandomIndex, type RandomState } from './random.js';
import { chunkKeyFor } from './spatial.js';

export interface Inventory {
  ore: number;
  wood: number;
  ingot: number;
  tool: number;
}
export type ItemId = keyof Inventory;
export interface Plot {
  x: number;
  y: number;
  size: number;
}
export interface Population {
  total: number;
  capacity: number;
  satisfaction: number;
  employed: number;
  unemployed: number;
}
export interface ResearchState {
  activeTechnology: TechnologyId | null;
  ticksRemaining: number;
  unlocked: Record<TechnologyId, boolean>;
}
export interface PlayerState {
  id: PlayerId;
  plot: Plot;
  inventory: Inventory;
  population: Population;
  exploredChunks: Record<string, true>;
  /** Current line-of-sight from active settlement assets; absent on pre-v20 snapshots. */
  visibleChunks?: Record<string, true>;
  territoryCells: Record<string, true>;
  research: ResearchState;
  lastSequence: number;
}
export interface Building {
  id: BuildingId;
  kind:
    'settlement-center' | 'smelter' | 'workshop' | 'storage' | 'housing' | 'hearth' | 'watchtower';
  ownerId: PlayerId;
  x: number;
  y: number;
  health: number;
  maxHealth: number;
  progress: number;
  constructionTicks: number;
  /** Reserved construction inputs still waiting for a worker to deliver them. */
  constructionMaterials: Inventory;
  inventory: Inventory;
  inventoryCapacity: number;
  populationCapacity: number;
  jobPriority: 0 | 1 | 2 | 3;
  /** The configured recipe is always one allowed by the building's producer definition. */
  recipeId: string | null;
  productionState:
    | 'idle'
    | 'constructing'
    | 'working'
    | 'blocked-input'
    | 'blocked-output'
    | 'unassigned'
    | 'damaged';
}
export interface Threat {
  id: string;
  targetBuildingId: BuildingId;
  health: number;
  damage: number;
  spawnedTick: number;
  x: number;
  y: number;
}
export interface Scout {
  id: string;
  ownerId: PlayerId;
  x: number;
  y: number;
  target?: { x: number; y: number };
}
export interface ResourceTransfer {
  id: string;
  fromPlayerId: PlayerId;
  toPlayerId: PlayerId;
  item: ItemId;
  amount: number;
  tick: number;
}
export interface Settlement {
  id: string;
  ownerId: PlayerId;
  members: Record<string, SettlementRole>;
  invitations: Record<string, true>;
}
export interface LogisticsLink {
  id: string;
  ownerId: PlayerId;
  sourceBuildingId: BuildingId;
  targetBuildingId: BuildingId;
  item: ItemId;
  priority: 0 | 1 | 2 | 3;
  throughputPerTick: number;
  status:
    | 'idle'
    | 'transferred'
    | 'paused'
    | 'source-empty'
    | 'target-full'
    | 'target-reconfigured'
    | 'constructing';
}
export interface WorldState {
  schemaVersion: 19;
  seed: number;
  /** Server-only deterministic PRNG state. Never expose this to clients. */
  randomState: RandomState;
  tick: number;
  players: Record<string, PlayerState>;
  buildings: Record<string, Building>;
  threats: Record<string, Threat>;
  scouts?: Record<string, Scout>;
  transfers: ResourceTransfer[];
  settlements: Record<string, Settlement>;
  logisticsLinks: Record<string, LogisticsLink>;
  processedCommands: string[];
  minedTiles: Record<string, number>;
}
export interface WorldEvent {
  type:
    | 'playerJoined'
    | 'gathered'
    | 'buildingPlaced'
    | 'buildingCompleted'
    | 'buildingCancelled'
    | 'buildingDemolished'
    | 'smelted'
    | 'repaired'
    | 'hazard'
    | 'threatSpawned'
    | 'threatDefeated'
    | 'buildingDamaged'
    | 'resourceTransferred'
    | 'settlementMemberChanged';
  playerId?: PlayerId;
  buildingId?: BuildingId;
  environmentalEventId?: keyof typeof environmentalEvents;
  threatId?: string;
  targetPlayerId?: PlayerId;
}

/**
 * The authoritative order for one completed tick. Commands are validated before
 * this function is called; every phase below observes the results of the phases
 * before it. Keep this list and `advanceTick` in lock-step when adding systems.
 */
export const TICK_PIPELINE = [
  'advance-clock',
  'research-and-population',
  'construction-and-production',
  'environmental-events',
  'logistics',
  'threat-spawning',
  'threat-navigation-and-combat',
  'emit-events-and-mark-changes',
] as const;
export type TickPhase = (typeof TICK_PIPELINE)[number];

/** Optional, platform-neutral instrumentation for headless performance runs. */
export interface TickProfiler {
  now(): number;
  record(phase: TickPhase, durationMs: number): void;
}

const INVENTORY_CAPACITY = 100;
const GATHER_RANGE = 8;
const TERRITORY_CELL_SIZE = 8;
const RESOURCE_SECTOR_SIZE = 8;
/** Bounds all threat route work together, rather than once per threat. */
export const THREAT_PATH_VISITS_PER_TICK = 128;
const THREAT_PATH_VISITS_PER_SEARCH = 128;
const emptyInventory = (): Inventory => ({ ore: 0, wood: 0, ingot: 0, tool: 0 });
const tileKey = (x: number, y: number) => `${x}:${y}`;
const coordinateNoise = (seed: number, x: number, y: number) =>
  Math.abs(Math.imul(seed ^ x, 73856093) ^ Math.imul(y, 19349663));
const terrainNoise = (seed: number, x: number, y: number) => coordinateNoise(seed, x, y) % 23;
const resourceNodeAt = (seed: number, x: number, y: number): 'ore' | 'wood' | undefined => {
  const sectorX = Math.floor(x / RESOURCE_SECTOR_SIZE);
  const sectorY = Math.floor(y / RESOURCE_SECTOR_SIZE);
  const oreX = coordinateNoise(seed ^ 0x4f1bbcdd, sectorX, sectorY) % RESOURCE_SECTOR_SIZE;
  const oreY = coordinateNoise(seed ^ 0x19a4e6d3, sectorX, sectorY) % RESOURCE_SECTOR_SIZE;
  let woodX = coordinateNoise(seed ^ 0x74e1a2b9, sectorX, sectorY) % RESOURCE_SECTOR_SIZE;
  const woodY = coordinateNoise(seed ^ 0x2b6d9c41, sectorX, sectorY) % RESOURCE_SECTOR_SIZE;
  if (woodX === oreX && woodY === oreY) woodX = (woodX + 1) % RESOURCE_SECTOR_SIZE;
  const localX = x - sectorX * RESOURCE_SECTOR_SIZE;
  const localY = y - sectorY * RESOURCE_SECTOR_SIZE;
  if (localX === oreX && localY === oreY) return 'ore';
  if (localX === woodX && localY === woodY) return 'wood';
  return undefined;
};
export const terrainAt = (
  seed: number,
  x: number,
  y: number,
): 'grass' | 'water' | 'ore' | 'wood' => {
  const resource = resourceNodeAt(seed, x, y);
  if (resource) return resource;
  const value = terrainNoise(seed, x, y);
  if (value === 0) return 'water';
  return 'grass';
};
/** Finds a deterministic reachable ore deposit around a point, if one exists within the range. */
export const nearestOreTile = (seed: number, x: number, y: number, range: number) => {
  return nearestResourceTile(seed, x, y, range, 'ore');
};
export const nearestResourceTile = (
  seed: number,
  x: number,
  y: number,
  range: number,
  resource: 'ore' | 'wood',
) => {
  for (let distance = 0; distance <= range; distance += 1)
    for (let offsetX = -distance; offsetX <= distance; offsetX += 1) {
      const offsetY = distance - Math.abs(offsetX);
      const candidates = offsetY === 0 ? [y] : [y - offsetY, y + offsetY];
      for (const candidateY of candidates) {
        const candidateX = x + offsetX;
        if (terrainAt(seed, candidateX, candidateY) === resource)
          return { x: candidateX, y: candidateY };
      }
    }
  return undefined;
};
const inventoryTotal = (inventory: Inventory) =>
  inventory.ore + inventory.wood + inventory.ingot + inventory.tool;
const inventoryItems: readonly ItemId[] = ['ore', 'wood', 'ingot', 'tool'];
const hasInvalidInventory = (inventory: Inventory) =>
  inventoryItems.some((item) => !Number.isSafeInteger(inventory[item]) || inventory[item] < 0);
const constructionMaterialsFor = (kind: Building['kind']): Inventory => {
  const cost = buildingDefinitions[kind].cost as Partial<Inventory>;
  return {
    ore: cost.ore ?? 0,
    wood: cost.wood ?? 0,
    ingot: cost.ingot ?? 0,
    tool: cost.tool ?? 0,
  };
};
const canAffordConstruction = (inventory: Inventory, kind: Building['kind']) => {
  const cost = constructionMaterialsFor(kind);
  return inventoryItems.every((item) => inventory[item] >= cost[item]);
};
const deductConstructionCost = (inventory: Inventory, kind: Building['kind']) => {
  const cost = constructionMaterialsFor(kind);
  for (const item of inventoryItems) inventory[item] -= cost[item];
};
const canRefundConstructionCost = (inventory: Inventory, kind: Building['kind']) => {
  const cost = constructionMaterialsFor(kind);
  return (
    inventoryItems.every((item) => inventory[item] + cost[item] <= INVENTORY_CAPACITY) &&
    inventoryTotal(inventory) + inventoryTotal(cost) <= INVENTORY_CAPACITY
  );
};
const refundConstructionCost = (inventory: Inventory, kind: Building['kind']) => {
  const cost = constructionMaterialsFor(kind);
  for (const item of inventoryItems) inventory[item] += cost[item];
};
const canStore = (inventory: Inventory, capacity: number, item: ItemId, amount: number) =>
  Number.isInteger(amount) &&
  amount > 0 &&
  inventoryTotal(inventory) + amount <= capacity &&
  inventory[item] + amount <= INVENTORY_CAPACITY;
type ProductionRecipe = {
  readonly input: Readonly<Partial<Record<ItemId, number>>>;
  readonly output: Readonly<Partial<Record<ItemId, number>>>;
  readonly ticks: number;
};
const producerFor = (kind: Building['kind']) =>
  producerDefinitions[kind as keyof typeof producerDefinitions];
const recipeIdsFor = (kind: Building['kind']): readonly string[] =>
  producerFor(kind)?.recipeIds ?? [];
const defaultRecipeIdFor = (kind: Building['kind']) => producerFor(kind)?.defaultRecipeId ?? null;
const recipesById: Readonly<Record<string, ProductionRecipe>> = Object.fromEntries(
  Object.values(recipes).map((recipe) => [recipe.id, recipe]),
);
const recipeFor = (building: Building): ProductionRecipe | undefined =>
  building.recipeId && recipeIdsFor(building.kind).includes(building.recipeId)
    ? recipesById[building.recipeId]
    : undefined;
const isProducer = (kind: Building['kind']) => Boolean(producerFor(kind));
const acceptsRecipeInput = (building: Building, item: ItemId) =>
  Boolean(recipeFor(building)?.input[item]);
const hasRecipeInputs = (building: Building, recipe: ProductionRecipe) =>
  Object.entries(recipe.input).every(
    ([item, amount]) => building.inventory[item as ItemId] >= (amount ?? 0),
  );
const hasRecipeOutputCapacity = (building: Building, recipe: ProductionRecipe) =>
  Object.entries(recipe.output).every(([item, amount]) =>
    canStore(building.inventory, building.inventoryCapacity, item as ItemId, amount ?? 0),
  );
const canStartRecipe = (building: Building, recipe: ProductionRecipe) =>
  hasRecipeInputs(building, recipe) && hasRecipeOutputCapacity(building, recipe);
const outputReservationFor = (building: Building): Partial<Inventory> =>
  building.progress > 0 ? (recipeFor(building)?.output ?? {}) : {};
const logisticsThroughput = logisticsDefinitions.internalInventory.throughputPerTick;
const consumeRecipe = (building: Building, recipe: ProductionRecipe) => {
  for (const [item, amount] of Object.entries(recipe.input))
    building.inventory[item as ItemId] -= amount ?? 0;
};
const produceRecipe = (building: Building, recipe: ProductionRecipe) => {
  for (const [item, amount] of Object.entries(recipe.output))
    building.inventory[item as ItemId] += amount ?? 0;
};
const floorDiv = (value: number, divisor: number) => Math.floor(value / divisor);
const chunkKey = (x: number, y: number) => chunkKeyFor(x, y);
const territoryKey = (x: number, y: number) =>
  `${floorDiv(x, TERRITORY_CELL_SIZE)}:${floorDiv(y, TERRITORY_CELL_SIZE)}`;
const territoryNeighbors = (key: string) => {
  const [xText, yText] = key.split(':');
  const x = Number(xText);
  const y = Number(yText);
  return [`${x + 1}:${y}`, `${x - 1}:${y}`, `${x}:${y + 1}`, `${x}:${y - 1}`];
};

const plotCandidate = (ordinal: number): Plot => {
  const radius = Math.floor(ordinal / 4) + 1;
  const side = ordinal % 4;
  const positions = [
    [radius * 12, 0],
    [0, radius * 12],
    [-radius * 12, 0],
    [0, -radius * 12],
  ] as const;
  const [x, y] = positions[side] ?? [0, 0];
  return { x, y, size: 8 };
};

const plotsOverlap = (left: Plot, right: Plot) =>
  left.x < right.x + right.size &&
  left.x + left.size > right.x &&
  left.y < right.y + right.size &&
  left.y + left.size > right.y;

/**
 * Allocates the next unclaimed radial plot with a buildable center. The scan is
 * deterministic and the 12-tile spacing keeps the 8×8 settlement plots apart.
 */
const plotFor = (state: WorldState): Plot => {
  const claimed = Object.values(state.players).map((player) => player.plot);
  for (let ordinal = 0; ; ordinal += 1) {
    const candidate = plotCandidate(ordinal);
    const centerX = candidate.x + candidate.size - 2;
    const centerY = candidate.y + candidate.size - 2;
    if (
      terrainAt(state.seed, centerX, centerY) !== 'water' &&
      !claimed.some((plot) => plotsOverlap(plot, candidate))
    )
      return candidate;
  }
};

export const createWorld = (seed = 1): WorldState => ({
  schemaVersion: 19,
  seed,
  randomState: createRandomState(seed),
  tick: 0,
  players: {},
  buildings: {},
  threats: {},
  scouts: {},
  transfers: [],
  settlements: {},
  logisticsLinks: {},
  processedCommands: [],
  minedTiles: {},
});

export const joinPlayer = (state: WorldState, id: string): WorldEvent[] => {
  if (state.players[id]) return [];
  const typedId = playerId(id);
  const plot = plotFor(state);
  state.players[id] = {
    id: typedId,
    plot,
    inventory: { ore: 0, wood: 5, ingot: 0, tool: 0 },
    population: { total: 2, capacity: 2, satisfaction: 100, employed: 0, unemployed: 2 },
    exploredChunks: plotExploration(plot),
    visibleChunks: plotExploration(plot),
    territoryCells: plotTerritory(plot),
    research: {
      activeTechnology: null,
      ticksRemaining: 0,
      unlocked: { metallurgy: false, 'territorial-charter': false },
    },
    lastSequence: 0,
  };
  state.settlements[`settlement-${id}`] = {
    id: `settlement-${id}`,
    ownerId: typedId,
    members: { [id]: 'owner' },
    invitations: {},
  };
  const centerId = buildingId(`center-${id}`);
  const center = buildingDefinitions['settlement-center'];
  state.buildings[centerId] = {
    id: centerId,
    kind: 'settlement-center',
    ownerId: typedId,
    x: plot.x + plot.size - 2,
    y: plot.y + plot.size - 2,
    health: center.maxHealth,
    maxHealth: center.maxHealth,
    progress: 0,
    constructionTicks: center.constructionTicks,
    constructionMaterials: emptyInventory(),
    inventory: emptyInventory(),
    inventoryCapacity: center.inventoryCapacity,
    populationCapacity: center.populationCapacity,
    jobPriority: 0,
    recipeId: null,
    productionState: 'idle',
  };
  state.scouts ??= {};
  state.scouts[`scout-${id}`] = {
    id: `scout-${id}`,
    ownerId: typedId,
    x: plot.x + Math.floor(plot.size / 2),
    y: plot.y + Math.floor(plot.size / 2),
  };
  return [{ type: 'playerJoined', playerId: typedId }];
};

const inPlot = (plot: Plot, x: number, y: number) =>
  x >= plot.x && y >= plot.y && x < plot.x + plot.size && y < plot.y + plot.size;
const distance = (a: Plot, x: number, y: number) =>
  Math.abs(a.x + Math.floor(a.size / 2) - x) + Math.abs(a.y + Math.floor(a.size / 2) - y);
const plotTerritory = (plot: Plot): Record<string, true> => {
  const cells: Record<string, true> = {};
  for (let x = plot.x; x < plot.x + plot.size; x += TERRITORY_CELL_SIZE)
    for (let y = plot.y; y < plot.y + plot.size; y += TERRITORY_CELL_SIZE)
      cells[territoryKey(x, y)] = true;
  cells[territoryKey(plot.x + plot.size - 1, plot.y + plot.size - 1)] = true;
  return cells;
};
/**
 * Chunks a new settlement starts with revealed. The plot straddles chunk
 * boundaries and gathering is allowed anywhere within GATHER_RANGE of the plot
 * centre, so reveal every chunk that range touches — otherwise reachable ore or
 * wood can sit in an unexplored chunk the client never receives terrain for,
 * leaving it visible on no map yet impossible to select and gather.
 */
const plotExploration = (plot: Plot): Record<string, true> => {
  const centerX = plot.x + Math.floor(plot.size / 2);
  const centerY = plot.y + Math.floor(plot.size / 2);
  const chunks: Record<string, true> = {};
  for (let x = centerX - GATHER_RANGE; x <= centerX + GATHER_RANGE; x += 1)
    for (let y = centerY - GATHER_RANGE; y <= centerY + GATHER_RANGE; y += 1)
      if (Math.abs(centerX - x) + Math.abs(centerY - y) <= GATHER_RANGE)
        chunks[chunkKey(x, y)] = true;
  return chunks;
};
const individualSettlementsFor = (players: Record<string, { id: PlayerId }>) =>
  Object.fromEntries(
    Object.values(players).map((player) => {
      const id = `settlement-${player.id}`;
      return [id, { id, ownerId: player.id, members: { [player.id]: 'owner' }, invitations: {} }];
    }),
  ) as Record<string, Settlement>;
const isClaimedByOther = (state: WorldState, playerId: PlayerId, key: string) =>
  Object.values(state.players).some(
    (player) => player.id !== playerId && player.territoryCells[key],
  );
const canBuildAt = (state: WorldState, player: PlayerState, x: number, y: number) =>
  (inPlot(player.plot, x, y) || player.territoryCells[territoryKey(x, y)]) &&
  !isClaimedByOther(state, player.id, territoryKey(x, y));
const visibleChunksFor = (state: WorldState, player: PlayerState): Record<string, true> => {
  const visible: Record<string, true> = { [chunkKey(player.plot.x, player.plot.y)]: true };
  for (const building of Object.values(state.buildings)) {
    if (building.ownerId !== player.id || building.health <= 0) continue;
    const chunkX = Math.floor(building.x / 16);
    const chunkY = Math.floor(building.y / 16);
    for (let offsetX = -1; offsetX <= 1; offsetX += 1)
      for (let offsetY = -1; offsetY <= 1; offsetY += 1)
        visible[chunkKey(chunkX * 16 + offsetX * 16, chunkY * 16 + offsetY * 16)] = true;
  }
  for (const scout of Object.values(state.scouts ?? {}))
    if (scout.ownerId === player.id) visible[chunkKey(scout.x, scout.y)] = true;
  return visible;
};
const roleWeight: Record<SettlementRole, number> = {
  member: 0,
  builder: 1,
  logistics: 2,
  owner: 3,
};
export const settlementRoleFor = (
  state: WorldState,
  playerId: PlayerId,
  ownerId: PlayerId,
): SettlementRole | undefined => {
  let highest: SettlementRole | undefined;
  for (const settlement of Object.values(state.settlements)) {
    const playerRole = settlement.members[playerId];
    if (!playerRole || !settlement.members[ownerId]) continue;
    if (!highest || roleWeight[playerRole] > roleWeight[highest]) highest = playerRole;
  }
  return highest;
};
const canManageLogistics = (state: WorldState, playerId: PlayerId, building: Building) => {
  if (building.ownerId === playerId) return true;
  const role = settlementRoleFor(state, playerId, building.ownerId);
  return role === 'owner' || role === 'logistics';
};
const canConfigureBuilding = (state: WorldState, playerId: PlayerId, building: Building) => {
  if (building.ownerId === playerId) return true;
  const role = settlementRoleFor(state, playerId, building.ownerId);
  return role === 'owner' || role === 'builder';
};
const threatSpawnPosition = (state: WorldState, target: Building) => {
  const threat = threatDefinitions['raider-swarm'];
  for (let radius = threat.spawnDistance.min; radius <= threat.spawnDistance.max; radius += 1) {
    const candidates = [
      { x: target.x + radius, y: target.y },
      { x: target.x, y: target.y + radius },
      { x: target.x - radius, y: target.y },
      { x: target.x, y: target.y - radius },
    ];
    const candidate = candidates.find(
      (tile) =>
        terrainAt(state.seed, tile.x, tile.y) !== 'water' &&
        !Object.values(state.buildings).some(
          (building) => building.x === tile.x && building.y === tile.y,
        ),
    );
    if (candidate) return candidate;
  }
  return { x: target.x, y: target.y };
};
export const applyCommand = (
  state: WorldState,
  command: Command,
): { result: CommandResult; events: WorldEvent[] } => {
  const reject = (code: Extract<CommandResult, { accepted: false }>['code']) => ({
    result: { accepted: false as const, commandId: command.id, code },
    events: [],
  });
  const player = state.players[command.playerId];
  if (!player) return reject('unknown-player');
  if (!Number.isSafeInteger(command.sequence) || command.sequence < 1)
    return reject('out-of-order-command');
  if ('x' in command && (!Number.isSafeInteger(command.x) || !Number.isSafeInteger(command.y)))
    return reject('invalid-coordinate');
  if (state.processedCommands.includes(command.id)) return reject('duplicate-command');
  if (command.sequence <= player.lastSequence) return reject('out-of-order-command');
  const accept = (events: WorldEvent[]) => {
    player.lastSequence = command.sequence;
    state.processedCommands.push(command.id);
    return { result: { accepted: true as const, commandId: command.id }, events };
  };
  if (command.type === 'gather') {
    if (distance(player.plot, command.x, command.y) > GATHER_RANGE) return reject('out-of-range');
    const key = tileKey(command.x, command.y);
    const resource = terrainAt(state.seed, command.x, command.y);
    if (resource !== 'ore' && resource !== 'wood') return reject('resource-depleted');
    if ((state.minedTiles[key] ?? 0) >= resourceDefinitions[resource].yield)
      return reject('resource-depleted');
    if (inventoryTotal(player.inventory) >= INVENTORY_CAPACITY) return reject('inventory-full');
    state.minedTiles[key] = (state.minedTiles[key] ?? 0) + 1;
    player.inventory[resource] += 1;
    return accept([{ type: 'gathered', playerId: player.id }]);
  }
  if (command.type === 'explore') {
    if (distance(player.plot, command.x, command.y) > 64) return reject('out-of-range');
    player.exploredChunks[chunkKey(command.x, command.y)] = true;
    return accept([]);
  }
  if (command.type === 'moveScout') {
    const scout = state.scouts?.[command.scoutId];
    if (!scout) return reject('unknown-scout');
    if (scout.ownerId !== player.id) return reject('unauthorized');
    if (Math.abs(scout.x - command.x) + Math.abs(scout.y - command.y) > 64)
      return reject('out-of-range');
    if (terrainAt(state.seed, command.x, command.y) === 'water')
      return reject('tile-not-buildable');
    scout.target = { x: command.x, y: command.y };
    return accept([]);
  }
  if (command.type === 'claimTerritory') {
    if (!player.research.unlocked['territorial-charter']) return reject('technology-locked');
    const key = territoryKey(command.x, command.y);
    if (!player.exploredChunks[chunkKey(command.x, command.y)]) return reject('not-explored');
    if (player.territoryCells[key] || isClaimedByOther(state, player.id, key))
      return reject('territory-claimed');
    if (!territoryNeighbors(key).some((neighbor) => player.territoryCells[neighbor]))
      return reject('not-adjacent');
    player.territoryCells[key] = true;
    return accept([]);
  }
  if (command.type === 'research') {
    const technology = technologies[command.technologyId];
    if (player.research.unlocked[technology.id]) return reject('already-researched');
    if (player.research.activeTechnology) return reject('research-in-progress');
    if (
      !technology.prerequisites.every(
        (prerequisite) => player.research.unlocked[prerequisite as TechnologyId],
      )
    )
      return reject('technology-locked');
    const unmetCost = Object.entries(technology.cost).find(
      ([item, amount]) => player.inventory[item as ItemId] < (amount ?? 0),
    );
    if (unmetCost) return reject('insufficient-resources');
    for (const [item, amount] of Object.entries(technology.cost))
      player.inventory[item as ItemId] -= amount ?? 0;
    player.research.activeTechnology = technology.id;
    player.research.ticksRemaining = technology.ticks;
    return accept([]);
  }
  if (command.type === 'transferToPlayer') {
    const target = state.players[command.targetPlayerId];
    if (!target) return reject('unknown-recipient');
    if (target.id === player.id) return reject('invalid-amount');
    if (!Number.isInteger(command.amount) || command.amount < 1) return reject('invalid-amount');
    if (player.inventory[command.item] < command.amount)
      return reject(command.item === 'ore' ? 'insufficient-ore' : 'inventory-full');
    if (!canStore(target.inventory, INVENTORY_CAPACITY, command.item, command.amount))
      return reject('inventory-full');
    player.inventory[command.item] -= command.amount;
    target.inventory[command.item] += command.amount;
    state.transfers.push({
      id: command.id,
      fromPlayerId: player.id,
      toPlayerId: target.id,
      item: command.item,
      amount: command.amount,
      tick: state.tick,
    });
    if (state.transfers.length > 1_000) state.transfers.shift();
    return accept([
      { type: 'resourceTransferred', playerId: player.id, targetPlayerId: target.id },
    ]);
  }
  if (command.type === 'inviteToSettlement') {
    const settlement = state.settlements[command.settlementId];
    if (!settlement) return reject('unknown-settlement');
    if (settlement.members[player.id] !== 'owner') return reject('settlement-permission-denied');
    if (!state.players[command.targetPlayerId]) return reject('unknown-recipient');
    if (settlement.members[command.targetPlayerId]) return reject('already-settlement-member');
    settlement.invitations[command.targetPlayerId] = true;
    return accept([{ type: 'settlementMemberChanged', playerId: command.targetPlayerId }]);
  }
  if (command.type === 'acceptSettlementInvite') {
    const settlement = state.settlements[command.settlementId];
    if (!settlement) return reject('unknown-settlement');
    if (settlement.members[player.id]) return reject('already-settlement-member');
    if (!settlement.invitations[player.id]) return reject('settlement-invite-missing');
    delete settlement.invitations[player.id];
    settlement.members[player.id] = 'member';
    return accept([{ type: 'settlementMemberChanged', playerId: player.id }]);
  }
  if (command.type === 'setSettlementRole') {
    const settlement = state.settlements[command.settlementId];
    if (!settlement) return reject('unknown-settlement');
    if (settlement.members[player.id] !== 'owner') return reject('settlement-permission-denied');
    if (!settlement.members[command.targetPlayerId]) return reject('not-settlement-member');
    if (settlement.ownerId === command.targetPlayerId)
      return reject('settlement-permission-denied');
    settlement.members[command.targetPlayerId] = command.role;
    return accept([{ type: 'settlementMemberChanged', playerId: command.targetPlayerId }]);
  }
  if (command.type === 'transferSettlementOwnership') {
    const settlement = state.settlements[command.settlementId];
    if (!settlement) return reject('unknown-settlement');
    if (settlement.ownerId !== player.id) return reject('settlement-permission-denied');
    if (command.targetPlayerId === player.id)
      return reject('cannot-transfer-settlement-ownership-to-self');
    if (!settlement.members[command.targetPlayerId]) return reject('not-settlement-member');
    settlement.members[player.id] = 'member';
    settlement.members[command.targetPlayerId] = 'owner';
    settlement.ownerId = command.targetPlayerId;
    return accept([
      { type: 'settlementMemberChanged', playerId: player.id },
      { type: 'settlementMemberChanged', playerId: command.targetPlayerId },
    ]);
  }
  if (command.type === 'leaveSettlement') {
    const settlement = state.settlements[command.settlementId];
    if (!settlement) return reject('unknown-settlement');
    if (!settlement.members[player.id]) return reject('not-settlement-member');
    if (settlement.ownerId === player.id) return reject('cannot-leave-settlement-owner');
    delete settlement.members[player.id];
    return accept([{ type: 'settlementMemberChanged', playerId: player.id }]);
  }
  if (command.type === 'removeSettlementMember') {
    const settlement = state.settlements[command.settlementId];
    if (!settlement) return reject('unknown-settlement');
    if (settlement.ownerId !== player.id) return reject('settlement-permission-denied');
    if (!settlement.members[command.targetPlayerId]) return reject('not-settlement-member');
    if (settlement.ownerId === command.targetPlayerId)
      return reject('cannot-remove-settlement-owner');
    delete settlement.members[command.targetPlayerId];
    return accept([{ type: 'settlementMemberChanged', playerId: command.targetPlayerId }]);
  }
  if (command.type === 'createLogisticsLink') {
    const source = state.buildings[command.sourceBuildingId];
    const target = state.buildings[command.targetBuildingId];
    if (!source || !target) return reject('unknown-building');
    if (
      source.id === target.id ||
      (source.kind !== 'storage' && !isProducer(source.kind)) ||
      !isProducer(target.kind) ||
      !acceptsRecipeInput(target, command.item) ||
      source.constructionTicks > 0 ||
      target.constructionTicks > 0
    )
      return reject('invalid-logistics-link');
    if (
      !canManageLogistics(state, player.id, source) ||
      !canManageLogistics(state, player.id, target)
    )
      return reject('settlement-permission-denied');
    const id = `link-${source.id}-${target.id}-${command.item}`;
    if (state.logisticsLinks[id]) return reject('logistics-link-exists');
    state.logisticsLinks[id] = {
      id,
      ownerId: player.id,
      sourceBuildingId: source.id,
      targetBuildingId: target.id,
      item: command.item,
      priority: 1,
      throughputPerTick: logisticsThroughput,
      status: 'idle',
    };
    return accept([]);
  }
  if (command.type === 'removeLogisticsLink') {
    const link = state.logisticsLinks[command.linkId];
    if (!link) return reject('unknown-logistics-link');
    const source = state.buildings[link.sourceBuildingId];
    const target = state.buildings[link.targetBuildingId];
    if (
      player.id !== link.ownerId &&
      (!source ||
        !target ||
        !canManageLogistics(state, player.id, source) ||
        !canManageLogistics(state, player.id, target))
    )
      return reject('settlement-permission-denied');
    delete state.logisticsLinks[link.id];
    return accept([]);
  }
  if (command.type === 'setLogisticsPriority') {
    const link = state.logisticsLinks[command.linkId];
    if (!link) return reject('unknown-logistics-link');
    const source = state.buildings[link.sourceBuildingId];
    const target = state.buildings[link.targetBuildingId];
    if (
      player.id !== link.ownerId &&
      (!source ||
        !target ||
        !canManageLogistics(state, player.id, source) ||
        !canManageLogistics(state, player.id, target))
    )
      return reject('settlement-permission-denied');
    link.priority = command.priority;
    return accept([]);
  }
  if (command.type === 'copyBuildingConfiguration') {
    const source = state.buildings[command.sourceBuildingId];
    const target = state.buildings[command.targetBuildingId];
    if (!source || !target) return reject('unknown-building');
    if (
      source.id === target.id ||
      source.kind !== target.kind ||
      !isProducer(source.kind) ||
      !isProducer(target.kind)
    )
      return reject('incompatible-building');
    if (source.constructionTicks > 0 || target.constructionTicks > 0)
      return reject('construction-incomplete');
    if (target.progress > 0) return reject('busy');
    if (
      !canConfigureBuilding(state, player.id, source) ||
      !canConfigureBuilding(state, player.id, target)
    )
      return reject('settlement-permission-denied');
    target.recipeId = source.recipeId;
    target.jobPriority = source.jobPriority;
    return accept([]);
  }
  const isPlacement =
    command.type === 'placeSmelter' ||
    command.type === 'placeWorkshop' ||
    command.type === 'placeStorage' ||
    command.type === 'placeHousing' ||
    command.type === 'placeHearth' ||
    command.type === 'placeWatchtower';
  const building =
    command.type === 'placeSmelter' ||
    command.type === 'placeWorkshop' ||
    command.type === 'placeStorage' ||
    command.type === 'placeHousing' ||
    command.type === 'placeHearth' ||
    command.type === 'placeWatchtower'
      ? undefined
      : state.buildings[command.buildingId];
  if (isPlacement) {
    if (!canBuildAt(state, player, command.x, command.y)) return reject('outside-plot');
    if (terrainAt(state.seed, command.x, command.y) === 'water')
      return reject('tile-not-buildable');
    if (
      Object.values(state.buildings).some(
        (candidate) => candidate.x === command.x && candidate.y === command.y,
      )
    )
      return reject('occupied');
    const kind =
      command.type === 'placeSmelter'
        ? 'smelter'
        : command.type === 'placeWorkshop'
          ? 'workshop'
          : command.type === 'placeStorage'
            ? 'storage'
            : command.type === 'placeHousing'
              ? 'housing'
              : command.type === 'placeHearth'
                ? 'hearth'
                : 'watchtower';
    const definition = buildingDefinitions[kind];
    if (definition.requiredTechnology && !player.research.unlocked[definition.requiredTechnology])
      return reject('technology-locked');
    if (!canAffordConstruction(player.inventory, kind)) return reject('insufficient-wood');
    const id = buildingId(`${kind}-${state.tick}-${Object.keys(state.buildings).length}`);
    deductConstructionCost(player.inventory, kind);
    state.buildings[id] = {
      id,
      kind,
      ownerId: player.id,
      x: command.x,
      y: command.y,
      health: definition.maxHealth,
      maxHealth: definition.maxHealth,
      progress: 0,
      constructionTicks: definition.constructionTicks,
      constructionMaterials: constructionMaterialsFor(kind),
      inventory: emptyInventory(),
      inventoryCapacity: definition.inventoryCapacity,
      populationCapacity: definition.populationCapacity,
      jobPriority: isProducer(kind) ? 1 : 0,
      recipeId: defaultRecipeIdFor(kind),
      productionState: definition.constructionTicks > 0 ? 'constructing' : 'idle',
    };
    return accept([{ type: 'buildingPlaced', playerId: player.id, buildingId: id }]);
  }
  if (!building) return reject('unknown-building');
  if (building.ownerId !== player.id) {
    const role = settlementRoleFor(state, player.id, building.ownerId);
    const permitted =
      role === 'owner' || (command.type === 'transfer' ? role === 'logistics' : role === 'builder');
    if (!permitted) return reject('settlement-permission-denied');
  }
  if (building.health <= 0 && command.type !== 'repair' && command.type !== 'demolish')
    return reject('building-destroyed');
  if (command.type === 'cancelConstruction') {
    if (building.kind === 'settlement-center') return reject('cannot-demolish');
    if (building.constructionTicks === 0) return reject('construction-incomplete');
    const owner = state.players[building.ownerId];
    if (!owner || !canRefundConstructionCost(owner.inventory, building.kind))
      return reject('inventory-full');
    delete state.buildings[building.id];
    refundConstructionCost(owner.inventory, building.kind);
    return accept([{ type: 'buildingCancelled', playerId: player.id, buildingId: building.id }]);
  }
  if (command.type === 'demolish') {
    if (building.kind === 'settlement-center') return reject('cannot-demolish');
    if (building.constructionTicks > 0) return reject('construction-incomplete');
    if (
      inventoryTotal(player.inventory) + inventoryTotal(building.inventory) > INVENTORY_CAPACITY ||
      player.inventory.ore + building.inventory.ore > INVENTORY_CAPACITY ||
      player.inventory.wood + building.inventory.wood > INVENTORY_CAPACITY ||
      player.inventory.ingot + building.inventory.ingot > INVENTORY_CAPACITY ||
      player.inventory.tool + building.inventory.tool > INVENTORY_CAPACITY
    )
      return reject('inventory-full');
    player.inventory.ore += building.inventory.ore;
    player.inventory.wood += building.inventory.wood;
    player.inventory.ingot += building.inventory.ingot;
    player.inventory.tool += building.inventory.tool;
    delete state.buildings[building.id];
    return accept([{ type: 'buildingDemolished', playerId: player.id, buildingId: building.id }]);
  }
  if (command.type === 'setJobPriority') {
    if (!isProducer(building.kind)) return reject('wrong-building');
    building.jobPriority = command.priority;
    return accept([]);
  }
  if (command.type === 'setRecipe') {
    if (!isProducer(building.kind)) return reject('wrong-building');
    if (building.progress > 0) return reject('busy');
    if (!recipeIdsFor(building.kind).includes(command.recipeId)) return reject('invalid-recipe');
    building.recipeId = command.recipeId;
    return accept([]);
  }
  if (building.constructionTicks > 0) return reject('construction-incomplete');
  if (command.type === 'transfer') {
    if (!Number.isInteger(command.amount) || command.amount < 1) return reject('invalid-amount');
    const source = command.direction === 'toBuilding' ? player.inventory : building.inventory;
    const destination = command.direction === 'toBuilding' ? building.inventory : player.inventory;
    const capacity =
      command.direction === 'toBuilding' ? building.inventoryCapacity : INVENTORY_CAPACITY;
    if (source[command.item] < command.amount)
      return reject(command.item === 'ore' ? 'insufficient-ore' : 'inventory-full');
    if (!canStore(destination, capacity, command.item, command.amount))
      return reject('inventory-full');
    source[command.item] -= command.amount;
    destination[command.item] += command.amount;
    return accept([]);
  }
  if (command.type === 'smelt') {
    if (building.kind !== 'smelter') return reject('wrong-building');
    if (building.progress > 0) return reject('busy');
    const recipe = recipeFor(building);
    if (!recipe || !canStartRecipe(building, recipe))
      return reject(building.inventory.ore < 1 ? 'insufficient-ore' : 'inventory-full');
    consumeRecipe(building, recipe);
    building.progress = recipe.ticks;
    building.productionState = 'working';
    return accept([]);
  }
  building.health = Math.min(building.maxHealth, building.health + 2);
  return accept([{ type: 'repaired', playerId: player.id, buildingId: building.id }]);
};

/**
 * Higher job priorities always win, but equal-priority producers rotate by the
 * authoritative tick so lexicographically early IDs cannot monopolize workers.
 */
const fairJobOrder = (producers: readonly Building[], tick: number): Building[] => {
  const ordered: Building[] = [];
  for (let priority = 3; priority >= 1; priority -= 1) {
    const group = producers
      .filter((building) => building.jobPriority === priority)
      .sort((left, right) => left.id.localeCompare(right.id));
    if (group.length === 0) continue;
    const offset = tick % group.length;
    ordered.push(...group.slice(offset), ...group.slice(0, offset));
  }
  return ordered;
};

/** Rotates equal work across ticks so the same threats cannot consume every route budget. */
const fairThreatOrder = (threats: readonly Threat[], tick: number): Threat[] => {
  const ordered = [...threats].sort((left, right) => left.id.localeCompare(right.id));
  if (ordered.length === 0) return ordered;
  const offset = tick % ordered.length;
  return [...ordered.slice(offset), ...ordered.slice(0, offset)];
};

const fairConstructionOrder = (projects: readonly Building[], tick: number): Building[] => {
  const ordered = [...projects].sort((left, right) => left.id.localeCompare(right.id));
  if (ordered.length === 0) return ordered;
  const offset = tick % ordered.length;
  return [...ordered.slice(offset), ...ordered.slice(0, offset)];
};

export const advanceTick = (state: WorldState, profiler?: TickProfiler): WorldEvent[] => {
  const beginPhase = (phase: TickPhase) => {
    const startedAt = profiler?.now();
    return () => {
      if (startedAt !== undefined) profiler?.record(phase, profiler.now() - startedAt);
    };
  };
  // Phase 1: advance-clock.
  let endPhase = beginPhase('advance-clock');
  state.tick += 1;
  endPhase();
  const events: WorldEvent[] = [];
  const staffedSmelters = new Set<BuildingId>();
  const staffedConstruction = new Set<BuildingId>();
  // Phase 2: research-and-population.
  endPhase = beginPhase('research-and-population');
  for (const player of Object.values(state.players).sort((left, right) =>
    left.id.localeCompare(right.id),
  )) {
    if (player.research.activeTechnology) {
      player.research.ticksRemaining -= 1;
      if (player.research.ticksRemaining === 0) {
        player.research.unlocked[player.research.activeTechnology] = true;
        player.research.activeTechnology = null;
      }
    }
    // Reuse the ownership scan for all population calculations. This is a hot
    // phase in dense worlds, and previously scanned every building three times
    // for each player.
    const ownedBuildings = Object.values(state.buildings).filter(
      (building) => building.ownerId === player.id,
    );
    const completedBuildings = ownedBuildings.filter(
      (building) => building.constructionTicks === 0,
    );
    player.population.capacity = completedBuildings.reduce(
      (capacity, building) => capacity + building.populationCapacity,
      0,
    );
    if (state.tick % 200 === 0) {
      if (
        player.population.total < player.population.capacity &&
        player.population.satisfaction >= 50
      )
        player.population.total += 1;
      else if (player.population.total > 2 && player.population.satisfaction < 50)
        player.population.total -= 1;
    }
    const producers = fairJobOrder(
      completedBuildings.filter(
        (building) => isProducer(building.kind) && building.jobPriority > 0,
      ),
      state.tick,
    );
    const staffed = producers.slice(0, player.population.total);
    const availableConstructionWorkers = player.population.total - staffed.length;
    const constructionWorkers = fairConstructionOrder(
      ownedBuildings.filter((building) => building.constructionTicks > 0),
      state.tick,
    ).slice(0, availableConstructionWorkers);
    player.population.employed = staffed.length + constructionWorkers.length;
    player.population.unemployed = player.population.total - player.population.employed;
    const shelterSatisfaction = player.population.capacity >= player.population.total ? 60 : 0;
    const workSatisfaction =
      player.population.total === 0
        ? 40
        : Math.floor((player.population.employed * 40) / player.population.total);
    const serviceSatisfaction = completedBuildings.some(
      (building) => building.kind === 'hearth' && building.health === building.maxHealth,
    )
      ? buildingDefinitions.hearth.serviceSatisfaction
      : 0;
    player.population.satisfaction = Math.min(
      100,
      shelterSatisfaction + workSatisfaction + serviceSatisfaction,
    );
    for (const producer of staffed) staffedSmelters.add(producer.id);
    for (const project of constructionWorkers) staffedConstruction.add(project.id);
    player.visibleChunks = visibleChunksFor(state, player);
  }
  for (const scout of Object.values(state.scouts ?? {}).sort((left, right) =>
    left.id.localeCompare(right.id),
  )) {
    const target = scout.target;
    if (!target) continue;
    const path = findPath({
      start: scout,
      goal: target,
      maxVisited: 64,
      bounds: {
        minX: Math.min(scout.x, target.x) - 4,
        maxX: Math.max(scout.x, target.x) + 4,
        minY: Math.min(scout.y, target.y) - 4,
        maxY: Math.max(scout.y, target.y) + 4,
      },
      isPassable: (tile) =>
        (tile.x === target.x && tile.y === target.y) ||
        (terrainAt(state.seed, tile.x, tile.y) !== 'water' &&
          !Object.values(state.buildings).some(
            (building) => building.x === tile.x && building.y === tile.y,
          )),
    });
    const next = path.status === 'found' ? path.path[1] : undefined;
    if (next) {
      scout.x = next.x;
      scout.y = next.y;
    }
    if ((scout.x === target.x && scout.y === target.y) || path.status !== 'found')
      delete scout.target;
    const owner = state.players[scout.ownerId];
    if (owner) owner.exploredChunks[chunkKey(scout.x, scout.y)] = true;
  }
  for (const player of Object.values(state.players))
    player.visibleChunks = visibleChunksFor(state, player);
  endPhase();
  // Phase 3: construction-and-production.
  endPhase = beginPhase('construction-and-production');
  for (const building of Object.values(state.buildings).sort((left, right) =>
    left.id.localeCompare(right.id),
  )) {
    if (building.constructionTicks > 0) {
      building.productionState = 'constructing';
      if (!staffedConstruction.has(building.id)) continue;
      const nextMaterial = inventoryItems.find((item) => building.constructionMaterials[item] > 0);
      if (nextMaterial) {
        building.constructionMaterials[nextMaterial] -= 1;
      }
      building.constructionTicks -= 1;
      if (building.constructionTicks === 0)
        events.push({
          type: 'buildingCompleted',
          buildingId: building.id,
          playerId: building.ownerId,
        });
      continue;
    }
    const recipe = recipeFor(building);
    if (!recipe) {
      building.productionState = 'idle';
      continue;
    }
    if (building.health !== building.maxHealth) {
      building.productionState = 'damaged';
      continue;
    }
    if (!staffedSmelters.has(building.id)) {
      building.productionState = 'unassigned';
      continue;
    }
    if (building.progress > 0) {
      building.productionState = 'working';
      building.progress -= 1;
      if (building.progress === 0) {
        produceRecipe(building, recipe);
        events.push({ type: 'smelted', buildingId: building.id, playerId: building.ownerId });
      }
    } else if (!hasRecipeInputs(building, recipe)) {
      building.productionState = 'blocked-input';
    } else if (!hasRecipeOutputCapacity(building, recipe)) {
      building.productionState = 'blocked-output';
    } else if (canStartRecipe(building, recipe)) {
      consumeRecipe(building, recipe);
      building.progress = recipe.ticks;
      building.productionState = 'working';
    }
  }
  endPhase();
  // Phase 4: environmental-events.
  endPhase = beginPhase('environmental-events');
  const acidRain = environmentalEvents['acid-rain'];
  if (state.tick % acidRain.intervalTicks === 0) {
    const targets = Object.values(state.buildings)
      .filter((building) => building.constructionTicks === 0 && building.health > 0)
      .sort((left, right) => left.id.localeCompare(right.id));
    const [nextRandomState, targetIndex] =
      targets.length > 0
        ? takeRandomIndex(state.randomState, targets.length)
        : [state.randomState, 0];
    state.randomState = nextRandomState;
    const target = targets[targetIndex];
    if (target) {
      target.health = Math.max(0, target.health - acidRain.damage);
      events.push({
        type: 'hazard',
        buildingId: target.id,
        environmentalEventId: acidRain.id,
      });
    }
  }
  endPhase();
  // Phase 5: logistics.
  endPhase = beginPhase('logistics');
  const sourceReservations = new Map<string, number>();
  const targetReservations = new Map<string, number>();
  const logisticsReservations: Array<{ link: LogisticsLink; amount: number }> = [];
  for (const link of Object.values(state.logisticsLinks).sort(
    (left, right) => right.priority - left.priority || left.id.localeCompare(right.id),
  )) {
    const source = state.buildings[link.sourceBuildingId];
    const target = state.buildings[link.targetBuildingId];
    if (!source || !target) {
      delete state.logisticsLinks[link.id];
      continue;
    }
    if (link.priority === 0) {
      link.status = 'paused';
      continue;
    }
    if (source.constructionTicks > 0 || target.constructionTicks > 0) {
      link.status = 'constructing';
      continue;
    }
    if (!acceptsRecipeInput(target, link.item)) {
      link.status = 'target-reconfigured';
      continue;
    }
    const sourceKey = `${source.id}:${link.item}`;
    const sourceAvailable = source.inventory[link.item] - (sourceReservations.get(sourceKey) ?? 0);
    if (sourceAvailable < 1) {
      link.status = 'source-empty';
      continue;
    }
    const targetKey = `${target.id}:${link.item}`;
    const outputReservation = outputReservationFor(target);
    const totalOutputReservation = inventoryItems.reduce(
      (total, item) => total + (outputReservation[item] ?? 0),
      0,
    );
    const availableCapacity =
      target.inventoryCapacity -
      inventoryTotal(target.inventory) -
      totalOutputReservation -
      (targetReservations.get(target.id) ?? 0);
    const availableStack =
      INVENTORY_CAPACITY -
      target.inventory[link.item] -
      (outputReservation[link.item] ?? 0) -
      (targetReservations.get(targetKey) ?? 0);
    const amount = Math.min(
      link.throughputPerTick,
      sourceAvailable,
      availableCapacity,
      availableStack,
    );
    if (amount < 1) {
      link.status = 'target-full';
      continue;
    }
    sourceReservations.set(sourceKey, (sourceReservations.get(sourceKey) ?? 0) + amount);
    targetReservations.set(target.id, (targetReservations.get(target.id) ?? 0) + amount);
    targetReservations.set(targetKey, (targetReservations.get(targetKey) ?? 0) + amount);
    logisticsReservations.push({ link, amount });
  }
  for (const { link, amount } of logisticsReservations) {
    const source = state.buildings[link.sourceBuildingId]!;
    const target = state.buildings[link.targetBuildingId]!;
    source.inventory[link.item] -= amount;
    target.inventory[link.item] += amount;
    link.status = 'transferred';
  }
  endPhase();
  // Phase 6: threat-spawning.
  endPhase = beginPhase('threat-spawning');
  const raider = threatDefinitions['raider-swarm'];
  if (state.tick % raider.spawnIntervalTicks === 0) {
    const targets = Object.values(state.buildings)
      .filter(
        (building) =>
          building.kind !== 'settlement-center' &&
          building.constructionTicks === 0 &&
          building.health > 0,
      )
      .sort((left, right) => left.id.localeCompare(right.id));
    const [nextRandomState, targetIndex] =
      targets.length > 0
        ? takeRandomIndex(state.randomState, targets.length)
        : [state.randomState, 0];
    state.randomState = nextRandomState;
    const target = targets[targetIndex];
    if (target) {
      const id = `raider-${state.tick}`;
      const spawn = threatSpawnPosition(state, target);
      state.threats[id] = {
        id,
        targetBuildingId: target.id,
        health: raider.health,
        damage: raider.damage,
        spawnedTick: state.tick,
        x: spawn.x,
        y: spawn.y,
      };
      events.push({ type: 'threatSpawned', buildingId: target.id, threatId: id });
    }
  }
  endPhase();
  // Phase 7: threat-navigation-and-combat.
  endPhase = beginPhase('threat-navigation-and-combat');
  // Threats may each visit many path tiles. Build these immutable per-tick
  // indexes once instead of scanning every building for every path tile.
  const occupiedBuildingTiles = new Set(
    Object.values(state.buildings).map((building) => tileKey(building.x, building.y)),
  );
  const watchtowersByOwner = new Map<string, Building[]>();
  for (const building of Object.values(state.buildings)) {
    if (building.kind !== 'watchtower' || building.constructionTicks > 0 || building.health <= 0)
      continue;
    const towers = watchtowersByOwner.get(building.ownerId) ?? [];
    towers.push(building);
    watchtowersByOwner.set(building.ownerId, towers);
  }
  let pathVisitsRemaining = THREAT_PATH_VISITS_PER_TICK;
  for (const threat of fairThreatOrder(Object.values(state.threats), state.tick)) {
    const target = state.buildings[threat.targetBuildingId];
    if (!target || target.health <= 0) {
      delete state.threats[threat.id];
      continue;
    }
    const path =
      pathVisitsRemaining > 0
        ? chunkFor(threat).x !== chunkFor(target).x || chunkFor(threat).y !== chunkFor(target).y
          ? findHierarchicalPath({
              start: threat,
              goal: target,
              maxVisited: Math.min(THREAT_PATH_VISITS_PER_SEARCH, pathVisitsRemaining),
              maxChunkVisited: 32,
              bounds: {
                minX: Math.min(threat.x, target.x) - 8,
                maxX: Math.max(threat.x, target.x) + 8,
                minY: Math.min(threat.y, target.y) - 8,
                maxY: Math.max(threat.y, target.y) + 8,
              },
              isChunkPassable: () => true,
              isPassable: (tile) =>
                (tile.x === target.x && tile.y === target.y) ||
                (terrainAt(state.seed, tile.x, tile.y) !== 'water' &&
                  !occupiedBuildingTiles.has(tileKey(tile.x, tile.y))),
            })
          : findPath({
              start: threat,
              goal: target,
              maxVisited: Math.min(THREAT_PATH_VISITS_PER_SEARCH, pathVisitsRemaining),
              bounds: {
                minX: Math.min(threat.x, target.x) - 8,
                maxX: Math.max(threat.x, target.x) + 8,
                minY: Math.min(threat.y, target.y) - 8,
                maxY: Math.max(threat.y, target.y) + 8,
              },
              isPassable: (tile) =>
                (tile.x === target.x && tile.y === target.y) ||
                (terrainAt(state.seed, tile.x, tile.y) !== 'water' &&
                  !occupiedBuildingTiles.has(tileKey(tile.x, tile.y))),
            })
        : undefined;
    pathVisitsRemaining -= path?.visited ?? 0;
    const next = path?.status === 'found' ? path.path[1] : undefined;
    if (next) {
      threat.x = next.x;
      threat.y = next.y;
    }
    const defense =
      (watchtowersByOwner.get(target.ownerId) ?? []).filter(
        (tower) => manhattanDistance(tower, threat) <= raider.watchtowerRange,
      ).length * buildingDefinitions.watchtower.defenseDamage;
    threat.health -= defense;
    if (threat.health <= 0) {
      delete state.threats[threat.id];
      events.push({ type: 'threatDefeated', buildingId: target.id, threatId: threat.id });
      continue;
    }
    if (manhattanDistance(threat, target) <= 1 && state.tick % 10 === 0) {
      target.health = Math.max(0, target.health - threat.damage);
      events.push({ type: 'buildingDamaged', buildingId: target.id, threatId: threat.id });
    }
  }
  // Phase 8: emit-events-and-mark-changes. Events are returned; callers obtain
  // an entity/chunk dirty set with `diffWorld` against their pre-tick snapshot.
  endPhase();
  endPhase = beginPhase('emit-events-and-mark-changes');
  endPhase();
  return events;
};

interface LegacyPlayer {
  id: PlayerId;
  plot: Plot;
  inventory: Inventory;
  lastSequence: number;
}
interface Version2Building {
  id: BuildingId;
  kind: 'settlement-center' | 'smelter';
  ownerId: PlayerId;
  x: number;
  y: number;
  health: number;
  maxHealth: number;
  progress: number;
  constructionTicks: number;
}
interface Version2World {
  schemaVersion: 2;
  seed: number;
  tick: number;
  players: Record<string, LegacyPlayer>;
  buildings: Record<string, Version2Building>;
  processedCommands: string[];
  minedTiles: Record<string, number>;
}
interface Version3Building {
  id: BuildingId;
  kind: 'settlement-center' | 'smelter' | 'storage';
  ownerId: PlayerId;
  x: number;
  y: number;
  health: number;
  maxHealth: number;
  progress: number;
  constructionTicks: number;
  inventory: Inventory;
  inventoryCapacity: number;
}
interface Version3World {
  schemaVersion: 3;
  seed: number;
  tick: number;
  players: Record<string, LegacyPlayer>;
  buildings: Record<string, Version3Building>;
  processedCommands: string[];
  minedTiles: Record<string, number>;
}
type LegacyPopulation = Omit<Population, 'employed' | 'unemployed'>;
interface Version4Player extends LegacyPlayer {
  population: LegacyPopulation;
}
interface Version4Building extends Version3Building {
  populationCapacity: number;
}
interface Version4World {
  schemaVersion: 4;
  seed: number;
  tick: number;
  players: Record<string, Version4Player>;
  buildings: Record<string, Version4Building>;
  processedCommands: string[];
  minedTiles: Record<string, number>;
}
interface Version5Player extends Version4Player {
  exploredChunks: Record<string, true>;
  territoryCells: Record<string, true>;
  research: ResearchState;
}
interface Version5World {
  schemaVersion: 5;
  seed: number;
  tick: number;
  players: Record<string, Version5Player>;
  buildings: Record<string, Version4Building>;
  processedCommands: string[];
  minedTiles: Record<string, number>;
}
interface Version9Player extends Omit<PlayerState, 'population'> {
  population: LegacyPopulation;
}
type Version9Building = Omit<Building, 'jobPriority'>;
type LegacyThreat = Omit<Threat, 'x' | 'y'>;
type LegacyWorldBase = Omit<WorldState, 'schemaVersion' | 'randomState'>;
interface Version14World extends LegacyWorldBase {
  schemaVersion: 14;
}
type PreFlowLogisticsLink = Omit<LogisticsLink, 'throughputPerTick' | 'status'>;
type Version15LogisticsLink = Omit<PreFlowLogisticsLink, 'priority'>;
type LegacyBuildingWithoutRecipe = Omit<
  Building,
  'recipeId' | 'productionState' | 'constructionMaterials'
>;
interface Version16World extends Omit<
  WorldState,
  'schemaVersion' | 'buildings' | 'logisticsLinks'
> {
  schemaVersion: 16;
  buildings: Record<string, LegacyBuildingWithoutRecipe>;
  logisticsLinks: Record<string, PreFlowLogisticsLink>;
}
interface Version15World extends Omit<Version16World, 'schemaVersion' | 'logisticsLinks'> {
  schemaVersion: 15;
  logisticsLinks: Record<string, Version15LogisticsLink>;
}
interface Version17World extends Omit<
  WorldState,
  'schemaVersion' | 'buildings' | 'logisticsLinks'
> {
  schemaVersion: 17;
  buildings: Record<string, Omit<Building, 'productionState' | 'constructionMaterials'>>;
  logisticsLinks: Record<string, PreFlowLogisticsLink>;
}
interface Version18World extends Omit<WorldState, 'schemaVersion' | 'buildings'> {
  schemaVersion: 18;
  buildings: Record<string, Omit<Building, 'constructionMaterials'>>;
}
interface Version10World extends Omit<LegacyWorldBase, 'threats'> {
  schemaVersion: 10;
  threats: Record<string, LegacyThreat>;
}
type LegacyInventory = Omit<Inventory, 'tool'>;
interface Version11World extends Omit<LegacyWorldBase, 'players' | 'buildings'> {
  schemaVersion: 11;
  players: Record<string, Omit<PlayerState, 'inventory'> & { inventory: LegacyInventory }>;
  buildings: Record<string, Omit<Building, 'inventory'> & { inventory: LegacyInventory }>;
}
interface Version12World extends LegacyWorldBase {
  schemaVersion: 12;
}
interface Version13World extends LegacyWorldBase {
  schemaVersion: 13;
}
interface Version9World extends Omit<Version10World, 'schemaVersion' | 'players' | 'buildings'> {
  schemaVersion: 9;
  players: Record<string, Version9Player>;
  buildings: Record<string, Version9Building>;
}
interface Version8World extends Omit<Version9World, 'schemaVersion' | 'logisticsLinks'> {
  schemaVersion: 8;
}
interface Version7World extends Omit<
  Version9World,
  'schemaVersion' | 'settlements' | 'logisticsLinks'
> {
  schemaVersion: 7;
}
interface Version6World extends Omit<
  Version9World,
  'schemaVersion' | 'transfers' | 'settlements' | 'logisticsLinks'
> {
  schemaVersion: 6;
}
const withLaborFields = <T extends { population: LegacyPopulation }>(players: Record<string, T>) =>
  Object.fromEntries(
    Object.entries(players).map(([id, player]) => [
      id,
      {
        ...player,
        population: {
          ...player.population,
          employed: 0,
          unemployed: player.population.total,
        },
      },
    ]),
  );
const withJobPriorities = <T extends { kind: Building['kind'] }>(buildings: Record<string, T>) =>
  Object.fromEntries(
    Object.entries(buildings).map(([id, building]) => [
      id,
      { ...building, jobPriority: isProducer(building.kind) ? 1 : 0 },
    ]),
  );
const withConfiguredRecipes = <T extends { kind: Building['kind'] }>(
  buildings: Record<string, T>,
): Record<string, T & Pick<Building, 'recipeId'>> =>
  Object.fromEntries(
    Object.entries(buildings).map(([id, building]) => [
      id,
      { ...building, recipeId: defaultRecipeIdFor(building.kind) },
    ]),
  ) as Record<string, T & Pick<Building, 'recipeId'>>;
const withThreatPositions = (
  threats: Record<string, LegacyThreat>,
  buildings: Record<string, { x: number; y: number }>,
) =>
  Object.fromEntries(
    Object.entries(threats).map(([id, threat]) => {
      const target = buildings[threat.targetBuildingId];
      return [id, { ...threat, x: target?.x ?? 0, y: target?.y ?? 0 }];
    }),
  );
const migrateInventoryToTools = (inventory: Partial<Inventory>): Inventory => ({
  ore: inventory.ore ?? 0,
  wood: inventory.wood ?? 0,
  ingot: inventory.ingot ?? 0,
  tool: inventory.tool ?? 0,
});
const migrateMinedTilesToOreNodes = (seed: number, minedTiles: Record<string, number>) => {
  const migrated: Record<string, number> = {};
  for (const [key, amount] of Object.entries(minedTiles)) {
    const [xText, yText] = key.split(':');
    const x = Number(xText);
    const y = Number(yText);
    if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y) || !Number.isSafeInteger(amount))
      continue;
    const node = terrainAt(seed, x, y) === 'ore' ? { x, y } : nearestOreTile(seed, x, y, 16);
    if (!node) continue;
    const nodeKey = tileKey(node.x, node.y);
    migrated[nodeKey] = Math.min(
      resourceDefinitions.ore.yield,
      (migrated[nodeKey] ?? 0) + Math.max(0, amount),
    );
  }
  return migrated;
};
const withLogisticsPriorities = <T extends Version15LogisticsLink>(
  links: Record<string, T>,
): Record<string, PreFlowLogisticsLink> =>
  Object.fromEntries(
    Object.entries(links).map(([id, link]) => [id, { ...link, priority: 1 }]),
  ) as Record<string, PreFlowLogisticsLink>;
const withProductionStates = <
  T extends Omit<Building, 'productionState' | 'constructionMaterials'>,
>(
  buildings: Record<string, T>,
): Record<string, T & Pick<Building, 'productionState'>> =>
  Object.fromEntries(
    Object.entries(buildings).map(([id, building]) => [
      id,
      {
        ...building,
        productionState: building.constructionTicks > 0 ? 'constructing' : 'idle',
      },
    ]),
  ) as Record<string, T & Pick<Building, 'productionState'>>;
const withEmptyConstructionMaterials = <T extends Omit<Building, 'constructionMaterials'>>(
  buildings: Record<string, T>,
): Record<string, T & Pick<Building, 'constructionMaterials'>> =>
  Object.fromEntries(
    Object.entries(buildings).map(([id, building]) => [
      id,
      { ...building, constructionMaterials: emptyInventory() },
    ]),
  ) as Record<string, T & Pick<Building, 'constructionMaterials'>>;
const withFlowControls = <T extends PreFlowLogisticsLink>(
  links: Record<string, T>,
): Record<string, LogisticsLink> =>
  Object.fromEntries(
    Object.entries(links).map(([id, link]) => [
      id,
      { ...link, throughputPerTick: logisticsThroughput, status: 'idle' },
    ]),
  ) as Record<string, LogisticsLink>;
const migrateVersion17 = (state: Version17World): WorldState => ({
  ...state,
  schemaVersion: 19,
  buildings: withEmptyConstructionMaterials(withProductionStates(state.buildings)),
  logisticsLinks: withFlowControls(state.logisticsLinks),
});
const migrateVersion18 = (state: Version18World): WorldState => ({
  ...state,
  schemaVersion: 19,
  buildings: withEmptyConstructionMaterials(state.buildings),
});
const migrateVersion16 = (state: Version16World): Version17World => ({
  ...state,
  schemaVersion: 17,
  buildings: withConfiguredRecipes(state.buildings),
});
const migrateVersion15 = (state: Version15World): WorldState =>
  migrateVersion17(
    migrateVersion16({
      ...state,
      schemaVersion: 16,
      logisticsLinks: withLogisticsPriorities(state.logisticsLinks),
    }),
  );
const migrateVersion14 = (state: Version14World): WorldState =>
  migrateVersion15({
    ...state,
    schemaVersion: 15,
    randomState: createRandomState(state.seed),
  } as Version15World);
const migrateVersion13 = (state: Version13World): WorldState =>
  migrateVersion14({
    ...state,
    schemaVersion: 14,
  });
const migrateVersion12 = (state: Version12World): WorldState =>
  migrateVersion13({
    ...state,
    schemaVersion: 13,
    minedTiles: migrateMinedTilesToOreNodes(state.seed, state.minedTiles),
  });
const migrateToCurrentSchema = (state: unknown): WorldState => {
  const legacy = state as {
    players: Record<string, { inventory: Partial<Inventory> }>;
    buildings: Record<string, { inventory: Partial<Inventory> }>;
  };
  return migrateVersion12({
    ...(state as object),
    schemaVersion: 12,
    players: Object.fromEntries(
      Object.entries(legacy.players).map(([id, player]) => [
        id,
        { ...player, inventory: migrateInventoryToTools(player.inventory) },
      ]),
    ),
    buildings: Object.fromEntries(
      Object.entries(legacy.buildings).map(([id, building]) => [
        id,
        { ...building, inventory: migrateInventoryToTools(building.inventory) },
      ]),
    ),
  } as Version12World);
};

/** Forward-only snapshot migration kept inside the platform-independent simulation. */
export const deserializeWorld = (raw: unknown): WorldState => {
  const candidate = structuredClone(raw) as { schemaVersion?: number };
  if (candidate.schemaVersion === 19) return candidate as WorldState;
  if (candidate.schemaVersion === 18) return migrateVersion18(candidate as Version18World);
  if (candidate.schemaVersion === 17) return migrateVersion17(candidate as Version17World);
  if (candidate.schemaVersion === 16)
    return migrateVersion17(migrateVersion16(candidate as Version16World));
  if (candidate.schemaVersion === 15) return migrateVersion15(candidate as Version15World);
  if (candidate.schemaVersion === 14) return migrateVersion14(candidate as Version14World);
  if (candidate.schemaVersion === 13) return migrateVersion13(candidate as Version13World);
  if (candidate.schemaVersion === 12) return migrateVersion12(candidate as Version12World);
  if (candidate.schemaVersion === 11) return migrateToCurrentSchema(candidate as Version11World);
  if (candidate.schemaVersion === 10) {
    const legacy = candidate as Version10World;
    return migrateToCurrentSchema({
      ...legacy,
      schemaVersion: 11,
      threats: withThreatPositions(legacy.threats, legacy.buildings),
    });
  }
  if (candidate.schemaVersion === 9) {
    const legacy = candidate as Version9World;
    return migrateToCurrentSchema({
      ...legacy,
      schemaVersion: 11,
      players: withLaborFields(legacy.players),
      buildings: withJobPriorities(legacy.buildings),
      threats: withThreatPositions(legacy.threats, legacy.buildings),
    });
  }
  if (candidate.schemaVersion === 8) {
    const legacy = candidate as Version8World;
    return migrateToCurrentSchema({
      ...legacy,
      schemaVersion: 11,
      logisticsLinks: {},
      players: withLaborFields(legacy.players),
      buildings: withJobPriorities(legacy.buildings),
      threats: withThreatPositions(legacy.threats, legacy.buildings),
    });
  }
  if (candidate.schemaVersion === 7) {
    const legacy = candidate as Version7World;
    return migrateToCurrentSchema({
      ...legacy,
      schemaVersion: 11,
      settlements: individualSettlementsFor(legacy.players),
      logisticsLinks: {},
      players: withLaborFields(legacy.players),
      buildings: withJobPriorities(legacy.buildings),
      threats: withThreatPositions(legacy.threats, legacy.buildings),
    });
  }
  if (candidate.schemaVersion === 6) {
    const legacy = candidate as Version6World;
    return migrateToCurrentSchema({
      ...legacy,
      schemaVersion: 11,
      transfers: [],
      settlements: individualSettlementsFor(legacy.players),
      logisticsLinks: {},
      players: withLaborFields(legacy.players),
      buildings: withJobPriorities(legacy.buildings),
      threats: withThreatPositions(legacy.threats, legacy.buildings),
    });
  }
  if (candidate.schemaVersion === 5) {
    const legacy = candidate as Version5World;
    return migrateToCurrentSchema({
      ...legacy,
      schemaVersion: 11,
      threats: {},
      transfers: [],
      settlements: individualSettlementsFor(legacy.players),
      logisticsLinks: {},
      players: withLaborFields(legacy.players),
      buildings: withJobPriorities(legacy.buildings),
    });
  }
  if (candidate.schemaVersion === 4) {
    const legacy = candidate as Version4World;
    return migrateToCurrentSchema({
      ...legacy,
      schemaVersion: 11,
      threats: {},
      transfers: [],
      settlements: individualSettlementsFor(legacy.players),
      logisticsLinks: {},
      players: Object.fromEntries(
        Object.entries(legacy.players).map(([id, player]) => [
          id,
          {
            ...player,
            population: {
              ...player.population,
              employed: 0,
              unemployed: player.population.total,
            },
            exploredChunks: { [chunkKey(player.plot.x, player.plot.y)]: true },
            territoryCells: plotTerritory(player.plot),
            research: {
              activeTechnology: null,
              ticksRemaining: 0,
              unlocked: { metallurgy: false, 'territorial-charter': false },
            },
          },
        ]),
      ),
      buildings: withJobPriorities(legacy.buildings),
    });
  }
  if (candidate.schemaVersion === 3) {
    const legacy = candidate as Version3World;
    return migrateToCurrentSchema({
      ...legacy,
      schemaVersion: 11,
      threats: {},
      transfers: [],
      settlements: individualSettlementsFor(legacy.players),
      logisticsLinks: {},
      players: Object.fromEntries(
        Object.entries(legacy.players).map(([id, player]) => [
          id,
          {
            ...player,
            population: { total: 2, capacity: 2, satisfaction: 100, employed: 0, unemployed: 2 },
            exploredChunks: { [chunkKey(player.plot.x, player.plot.y)]: true },
            territoryCells: plotTerritory(player.plot),
            research: {
              activeTechnology: null,
              ticksRemaining: 0,
              unlocked: { metallurgy: false, 'territorial-charter': false },
            },
          },
        ]),
      ),
      buildings: Object.fromEntries(
        Object.entries(legacy.buildings).map(([id, building]) => [
          id,
          {
            ...building,
            populationCapacity: building.kind === 'settlement-center' ? 2 : 0,
            jobPriority: building.kind === 'smelter' ? 1 : 0,
          },
        ]),
      ),
    });
  }
  if (candidate.schemaVersion === 2) {
    const legacy = candidate as Version2World;
    return migrateToCurrentSchema({
      ...legacy,
      schemaVersion: 11,
      threats: {},
      transfers: [],
      settlements: individualSettlementsFor(legacy.players),
      logisticsLinks: {},
      players: Object.fromEntries(
        Object.entries(legacy.players).map(([id, player]) => [
          id,
          {
            ...player,
            population: { total: 2, capacity: 2, satisfaction: 100, employed: 0, unemployed: 2 },
            exploredChunks: { [chunkKey(player.plot.x, player.plot.y)]: true },
            territoryCells: plotTerritory(player.plot),
            research: {
              activeTechnology: null,
              ticksRemaining: 0,
              unlocked: { metallurgy: false, 'territorial-charter': false },
            },
          },
        ]),
      ),
      buildings: Object.fromEntries(
        Object.entries(legacy.buildings).map(([id, building]) => [
          id,
          {
            ...building,
            inventory: emptyInventory(),
            inventoryCapacity: building.kind === 'smelter' ? 20 : INVENTORY_CAPACITY,
            populationCapacity: building.kind === 'settlement-center' ? 2 : 0,
            jobPriority: building.kind === 'smelter' ? 1 : 0,
          },
        ]),
      ),
    });
  }
  throw new Error(`Unsupported world snapshot schema version: ${String(candidate.schemaVersion)}`);
};

export const snapshot = (state: WorldState): WorldState => structuredClone(state);
export const stateHash = (state: WorldState): string => stableHash(snapshot(state));

/** Read-only invariant inspection for checkpoints, migration verification, and operations. */
export const inspectWorld = (state: WorldState): string[] => {
  const errors: string[] = [];
  const isNonNegativeInteger = (value: number) => Number.isSafeInteger(value) && value >= 0;
  if (!Number.isSafeInteger(state.seed)) errors.push('world has an invalid seed');
  if (!isNonNegativeInteger(state.tick)) errors.push('world has an invalid tick');
  if (
    !Number.isSafeInteger(state.randomState) ||
    state.randomState < 1 ||
    state.randomState >= 0x1_0000_0000
  )
    errors.push('world has an invalid random state');
  const entityIds = new Map<string, string>();
  const registerEntity = (id: string, kind: string) => {
    const existing = entityIds.get(id);
    if (existing) errors.push(`entity id ${id} is shared by ${existing} and ${kind}`);
    else entityIds.set(id, kind);
  };
  const occupied = new Set<string>();
  for (const [id, player] of Object.entries(state.players)) {
    registerEntity(player.id, 'player');
    if (player.id !== id) errors.push(`player key ${id} does not match its id`);
    if (
      !isNonNegativeInteger(player.population.total) ||
      !isNonNegativeInteger(player.population.capacity) ||
      !isNonNegativeInteger(player.population.satisfaction) ||
      !isNonNegativeInteger(player.population.employed) ||
      !isNonNegativeInteger(player.population.unemployed) ||
      player.population.capacity < player.population.total ||
      player.population.employed + player.population.unemployed !== player.population.total
    )
      errors.push(`player ${id} has invalid population`);
    if (
      !Number.isSafeInteger(player.plot.x) ||
      !Number.isSafeInteger(player.plot.y) ||
      !Number.isSafeInteger(player.plot.size) ||
      player.plot.size < 1 ||
      !isNonNegativeInteger(player.lastSequence) ||
      !isNonNegativeInteger(player.research.ticksRemaining)
    )
      errors.push(`player ${id} has invalid plot or simulation state`);
    if (
      inventoryTotal(player.inventory) > INVENTORY_CAPACITY ||
      hasInvalidInventory(player.inventory)
    )
      errors.push(`player ${id} has invalid inventory`);
    if (
      player.visibleChunks &&
      Object.keys(player.visibleChunks).some((key) => {
        const [xText, yText] = key.split(':');
        return !Number.isSafeInteger(Number(xText)) || !Number.isSafeInteger(Number(yText));
      })
    )
      errors.push(`player ${id} has invalid visible chunks`);
  }
  for (const [id, building] of Object.entries(state.buildings)) {
    registerEntity(building.id, 'building');
    if (building.id !== id) errors.push(`building key ${id} does not match its id`);
    if (!state.players[building.ownerId])
      errors.push(`building ${id} has unknown owner ${building.ownerId}`);
    if (!Number.isSafeInteger(building.x) || !Number.isSafeInteger(building.y))
      errors.push(`building ${id} has invalid coordinates`);
    const position = tileKey(building.x, building.y);
    if (occupied.has(position)) errors.push(`multiple buildings occupy ${position}`);
    else occupied.add(position);
    if (
      !isNonNegativeInteger(building.health) ||
      !isNonNegativeInteger(building.maxHealth) ||
      !isNonNegativeInteger(building.progress) ||
      !isNonNegativeInteger(building.constructionTicks) ||
      !isNonNegativeInteger(building.inventoryCapacity) ||
      !isNonNegativeInteger(building.populationCapacity) ||
      building.health > building.maxHealth ||
      !Number.isInteger(building.jobPriority) ||
      building.jobPriority < 0 ||
      building.jobPriority > 3
    )
      errors.push(`building ${id} has invalid health or construction state`);
    if (
      inventoryTotal(building.inventory) > building.inventoryCapacity ||
      hasInvalidInventory(building.inventory)
    )
      errors.push(`building ${id} has invalid inventory`);
    const constructionCost = constructionMaterialsFor(building.kind);
    if (
      hasInvalidInventory(building.constructionMaterials) ||
      inventoryItems.some((item) => building.constructionMaterials[item] > constructionCost[item])
    )
      errors.push(`building ${id} has invalid construction materials`);
    if (
      (isProducer(building.kind) &&
        (!building.recipeId || !recipeIdsFor(building.kind).includes(building.recipeId))) ||
      (!isProducer(building.kind) && building.recipeId !== null)
    )
      errors.push(`building ${id} has an invalid configured recipe`);
    if (
      ![
        'idle',
        'constructing',
        'working',
        'blocked-input',
        'blocked-output',
        'unassigned',
        'damaged',
      ].includes(building.productionState)
    )
      errors.push(`building ${id} has an invalid production state`);
  }
  for (const [id, threat] of Object.entries(state.threats)) {
    registerEntity(threat.id, 'threat');
    if (threat.id !== id) errors.push(`threat key ${id} does not match its id`);
    if (!state.buildings[threat.targetBuildingId])
      errors.push(`threat ${id} has unknown target ${threat.targetBuildingId}`);
    if (
      !Number.isSafeInteger(threat.health) ||
      !Number.isSafeInteger(threat.damage) ||
      !isNonNegativeInteger(threat.spawnedTick) ||
      threat.health < 1 ||
      threat.damage < 1
    )
      errors.push(`threat ${id} has invalid combat values`);
    if (!Number.isSafeInteger(threat.x) || !Number.isSafeInteger(threat.y))
      errors.push(`threat ${id} has invalid coordinates`);
  }
  const transferIds = new Set<string>();
  for (const transfer of state.transfers) {
    if (transferIds.has(transfer.id)) errors.push(`duplicate transfer ${transfer.id}`);
    transferIds.add(transfer.id);
    if (!state.players[transfer.fromPlayerId] || !state.players[transfer.toPlayerId])
      errors.push(`transfer ${transfer.id} has an unknown participant`);
    if (!Number.isSafeInteger(transfer.amount) || transfer.amount < 1)
      errors.push(`transfer ${transfer.id} has an invalid amount`);
    if (!isNonNegativeInteger(transfer.tick))
      errors.push(`transfer ${transfer.id} has an invalid tick`);
  }
  const processedCommandIds = new Set<string>();
  for (const id of state.processedCommands) {
    if (processedCommandIds.has(id)) errors.push(`duplicate processed command ${id}`);
    processedCommandIds.add(id);
  }
  for (const [key, amount] of Object.entries(state.minedTiles)) {
    const [xText, yText] = key.split(':');
    if (
      !Number.isSafeInteger(Number(xText)) ||
      !Number.isSafeInteger(Number(yText)) ||
      !isNonNegativeInteger(amount) ||
      amount >
        (terrainAt(state.seed, Number(xText), Number(yText)) === 'wood'
          ? resourceDefinitions.wood.yield
          : resourceDefinitions.ore.yield)
    )
      errors.push(`mined tile ${key} has an invalid depletion value`);
  }
  for (const [id, settlement] of Object.entries(state.settlements)) {
    if (settlement.id !== id) errors.push(`settlement key ${id} does not match its id`);
    if (!state.players[settlement.ownerId])
      errors.push(`settlement ${id} has an unknown owner ${settlement.ownerId}`);
    if (settlement.members[settlement.ownerId] !== 'owner')
      errors.push(`settlement ${id} does not retain its owner role`);
    for (const [memberId, role] of Object.entries(settlement.members)) {
      if (!state.players[memberId])
        errors.push(`settlement ${id} has an unknown member ${memberId}`);
      if (!['owner', 'builder', 'logistics', 'member'].includes(role))
        errors.push(`settlement ${id} has an invalid role for ${memberId}`);
    }
    for (const invitedPlayerId of Object.keys(settlement.invitations)) {
      if (!state.players[invitedPlayerId])
        errors.push(`settlement ${id} has an unknown invitation recipient ${invitedPlayerId}`);
      if (settlement.members[invitedPlayerId])
        errors.push(`settlement ${id} invites an existing member ${invitedPlayerId}`);
    }
  }
  for (const [id, link] of Object.entries(state.logisticsLinks)) {
    if (link.id !== id) errors.push(`logistics link key ${id} does not match its id`);
    if (!state.players[link.ownerId]) errors.push(`logistics link ${id} has an unknown owner`);
    const source = state.buildings[link.sourceBuildingId];
    const target = state.buildings[link.targetBuildingId];
    if (
      !source ||
      !target ||
      (source.kind !== 'storage' && !isProducer(source.kind)) ||
      !isProducer(target.kind) ||
      !acceptsRecipeInput(target, link.item)
    )
      errors.push(`logistics link ${id} has invalid endpoints`);
    if (!Number.isInteger(link.priority) || link.priority < 0 || link.priority > 3)
      errors.push(`logistics link ${id} has an invalid priority`);
    if (
      !Number.isSafeInteger(link.throughputPerTick) ||
      link.throughputPerTick < 1 ||
      link.throughputPerTick > logisticsThroughput
    )
      errors.push(`logistics link ${id} has an invalid throughput`);
    if (
      ![
        'idle',
        'transferred',
        'paused',
        'source-empty',
        'target-full',
        'target-reconfigured',
        'constructing',
      ].includes(link.status)
    )
      errors.push(`logistics link ${id} has an invalid status`);
  }
  return errors;
};
