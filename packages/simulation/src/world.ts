import {
  buildingId,
  type BuildingId,
  type Command,
  type CommandResult,
  PLACEMENT_KINDS,
  playerId,
  type PlacementCommandType,
  type PlayerId,
  type SettlementRole,
  type SharedProjectBuildingKind,
} from './commands.js';
import {
  buildings as buildingDefinitions,
  CONTENT_VERSION,
  cooperativeObjectives as cooperativeObjectiveDefinitions,
  environmentalEvents,
  extractors as extractorDefinitions,
  logisticsLinks as logisticsDefinitions,
  onboardingRules,
  producers as producerDefinitions,
  renewers as renewerDefinitions,
  resources as resourceDefinitions,
  roadRules,
  recipes,
  socialRules,
  terrainRules,
  technologies,
  threats as threatDefinitions,
  worldRetention,
  type TechnologyId,
  type CooperativeObjectiveId,
  type LandmarkId,
} from '@kings/content';
import { chunkFor, findHierarchicalPath, findPath, manhattanDistance } from '@kings/pathfinding';
import { stableHash } from './hash.js';
import { isOpenTile, landmarkAtChunk, terrainAt } from './terrain.js';
export {
  elevationAt,
  isOpenTile,
  nearestOreTile,
  nearestResourceTile,
  terrainAt,
} from './terrain.js';
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
  discoveries: Record<string, LandmarkDiscovery>;
  lastSequence: number;
}
export interface LandmarkDiscovery {
  readonly kind: LandmarkId;
  readonly x: number;
  readonly y: number;
  readonly discoveredTick: number;
  readonly reward: Readonly<Partial<Inventory>>;
}
export interface Building {
  id: BuildingId;
  kind:
    | 'settlement-center'
    | 'smelter'
    | 'workshop'
    | 'storage'
    | 'housing'
    | 'hearth'
    | 'watchtower'
    | 'mine'
    | 'lumber-camp'
    | 'forester';
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
  /** Rough terrain consumes an extra tick unless a road reaches the tile. */
  moveCooldown?: number;
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
  /** Every link owns one deterministic carrier whose return journey limits throughput. */
  carrierId?: string;
  routeDistance?: number;
  travelTicksRemaining?: number;
  status:
    | 'idle'
    | 'transferred'
    | 'paused'
    | 'source-empty'
    | 'target-full'
    | 'target-reconfigured'
    | 'constructing'
    | 'in-transit';
}
export interface ObjectiveContribution {
  readonly commandId: string;
  readonly playerId: PlayerId;
  readonly settlementId: string;
  readonly item: ItemId;
  readonly amount: number;
  readonly tick: number;
}
export interface ObjectiveRewardClaim {
  readonly commandId: string;
  readonly playerId: PlayerId;
  readonly reward: Readonly<Partial<Inventory>>;
  readonly tick: number;
}
export interface CooperativeObjectiveState {
  readonly id: CooperativeObjectiveId;
  totalContributed: number;
  completedTick: number | null;
  contributionsBySettlement: Record<string, number>;
  contributionsByPlayer: Record<string, number>;
  rewardClaims: Record<string, string>;
  contributionHistory: ObjectiveContribution[];
  rewardHistory: ObjectiveRewardClaim[];
}
export interface PlayerActivity {
  /** Last accepted player command; persisted so recovery reproduces protection exactly. */
  lastActiveTick: number;
  /** New settlements cannot be selected by hazards or raids before this tick. */
  raidEligibleTick: number;
}
export interface SharedProjectContribution {
  readonly commandId: string;
  readonly playerId: PlayerId;
  readonly item: ItemId;
  readonly amount: number;
  readonly tick: number;
}
export interface SharedConstructionProject {
  readonly id: string;
  readonly settlementId: string;
  readonly createdBy: PlayerId;
  readonly buildingKind: SharedProjectBuildingKind;
  readonly x: number;
  readonly y: number;
  readonly required: Inventory;
  readonly contributed: Inventory;
  readonly createdTick: number;
  completedTick: number | null;
  buildingId: BuildingId | null;
  readonly contributionHistory: SharedProjectContribution[];
}
export interface ChatMessage {
  readonly id: string;
  readonly senderId: PlayerId;
  readonly senderName: string;
  readonly channel: 'global' | 'settlement';
  readonly settlementId?: string;
  readonly text: string;
  readonly tick: number;
}
export interface ChatReport {
  readonly id: string;
  readonly reporterId: PlayerId;
  readonly reportedMessage: ChatMessage;
  readonly reason: string;
  readonly tick: number;
  status: 'open' | 'resolved';
}
export interface SocialState {
  playerNames: Record<string, string>;
  settlementNames: Record<string, string>;
  blockedPlayers: Record<string, Record<string, true>>;
  lastChatTick: Record<string, number>;
  messages: ChatMessage[];
  reports: ChatReport[];
}
export interface DeletedPlayer {
  readonly id: PlayerId;
  readonly deletedTick: number;
  readonly reason?: 'account-deletion' | 'abandoned-onboarding';
}
export interface OnboardingReservation {
  readonly createdTick: number;
  expiresTick: number;
  securedTick: number | null;
}
export interface WorldState {
  schemaVersion: 29;
  contentVersion: typeof CONTENT_VERSION;
  seed: number;
  /** When true, no PvE threats spawn. Peaceful worlds stay threat-free. */
  peaceful: boolean;
  /** Server-only deterministic PRNG state. Never expose this to clients. */
  randomState: RandomState;
  tick: number;
  players: Record<string, PlayerState>;
  /** Server-only tombstones prevent deleted identities from silently re-registering. */
  deletedPlayers: Record<string, DeletedPlayer>;
  buildings: Record<string, Building>;
  threats: Record<string, Threat>;
  scouts?: Record<string, Scout>;
  transfers: ResourceTransfer[];
  settlements: Record<string, Settlement>;
  logisticsLinks: Record<string, LogisticsLink>;
  /** Traversable infrastructure keyed by tile; the value is its owning player. */
  roads: Record<string, PlayerId>;
  cooperativeObjectives: Record<CooperativeObjectiveId, CooperativeObjectiveState>;
  playerActivity: Record<string, PlayerActivity>;
  onboardingReservations: Record<string, OnboardingReservation>;
  sharedConstructionProjects: Record<string, SharedConstructionProject>;
  social: SocialState;
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
    | 'extracted'
    | 'repaired'
    | 'hazard'
    | 'threatSpawned'
    | 'threatDefeated'
    | 'buildingDamaged'
    | 'resourceTransferred'
    | 'settlementMemberChanged'
    | 'objectiveContributed'
    | 'objectiveCompleted'
    | 'objectiveRewardClaimed'
    | 'sharedProjectCreated'
    | 'sharedProjectContributed'
    | 'sharedProjectCompleted'
    | 'playerNameChanged'
    | 'settlementNameChanged'
    | 'chatMessageSent'
    | 'chatMessageReported'
    | 'playerBlockChanged'
    | 'playerDeleted'
    | 'onboardingReservationReclaimed'
    | 'landmarkDiscovered'
    | 'roadPlaced'
    | 'resourceRegenerated';
  playerId?: PlayerId;
  buildingId?: BuildingId;
  environmentalEventId?: keyof typeof environmentalEvents;
  threatId?: string;
  targetPlayerId?: PlayerId;
  objectiveId?: CooperativeObjectiveId;
  projectId?: string;
  landmarkKind?: LandmarkId;
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

export const PLAYER_INVENTORY_CAPACITY = 100;
export const INVENTORY_CAPACITY = PLAYER_INVENTORY_CAPACITY;
const MAX_ACTIVE_SHARED_PROJECTS_PER_SETTLEMENT = 3;
export const MAX_ACTIVE_CONSTRUCTIONS_PER_PLAYER = 64;
export const MAX_PLOT_CANDIDATE_ATTEMPTS = 100_000;
export const GATHER_RANGE = 8;
const TERRITORY_CELL_SIZE = 8;
/** Bounds all threat route work together, rather than once per threat. */
export const THREAT_PATH_VISITS_PER_TICK = 128;
const THREAT_PATH_VISITS_PER_SEARCH = 128;
export const emptyInventory = (): Inventory => ({ ore: 0, wood: 0, ingot: 0, tool: 0 });
export const initialSocialState = (): SocialState => ({
  playerNames: {},
  settlementNames: {},
  blockedPlayers: {},
  lastChatTick: {},
  messages: [],
  reports: [],
});
export const tileKey = (x: number, y: number) => `${x}:${y}`;
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
export const defaultRecipeIdFor = (kind: Building['kind']) =>
  producerFor(kind)?.defaultRecipeId ?? null;
const recipesById: Readonly<Record<string, ProductionRecipe>> = Object.fromEntries(
  Object.values(recipes).map((recipe) => [recipe.id, recipe]),
);
const recipeFor = (building: Building): ProductionRecipe | undefined =>
  building.recipeId && recipeIdsFor(building.kind).includes(building.recipeId)
    ? recipesById[building.recipeId]
    : undefined;
export const isProducer = (kind: Building['kind']) => Boolean(producerFor(kind));
const extractorFor = (kind: Building['kind']) =>
  extractorDefinitions[kind as keyof typeof extractorDefinitions];
const isExtractor = (kind: Building['kind']) => Boolean(extractorFor(kind));
const renewerFor = (kind: Building['kind']) =>
  renewerDefinitions[kind as keyof typeof renewerDefinitions];
const isRenewer = (kind: Building['kind']) => Boolean(renewerFor(kind));
/** Producers, extractors, and renewers occupy the same finite settler job pool. */
const needsWorker = (kind: Building['kind']) =>
  isProducer(kind) || isExtractor(kind) || isRenewer(kind);
const acceptsRecipeInput = (building: Building, item: ItemId) =>
  Boolean(recipeFor(building)?.input[item]);
const isStorageBuilding = (kind: Building['kind']) => kind === 'storage';
/** Producers accept only configured recipe inputs; storage buffers any item. */
const acceptsLogisticsItem = (building: Building, item: ItemId) =>
  isStorageBuilding(building.kind)
    ? building.inventoryCapacity > 0
    : acceptsRecipeInput(building, item);
const acceptedLinkSource = (kind: Building['kind']) =>
  (logisticsDefinitions.internalInventory.acceptedSourceKinds as readonly string[]).includes(kind);
const acceptedLinkTarget = (kind: Building['kind']) =>
  (logisticsDefinitions.internalInventory.acceptedTargetKinds as readonly string[]).includes(kind);
const isPlacementCommand = <T extends { readonly type: string }>(
  command: T,
): command is T & { readonly type: PlacementCommandType; readonly x: number; readonly y: number } =>
  command.type in PLACEMENT_KINDS;
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
export const logisticsThroughput = logisticsDefinitions.internalInventory.throughputPerTick;
const carrierRouteFor = (state: WorldState, source: Building, target: Building) => {
  const route: string[] = [];
  let x = source.x;
  let y = source.y;
  while (x !== target.x) {
    x += Math.sign(target.x - x);
    route.push(tileKey(x, y));
  }
  while (y !== target.y) {
    y += Math.sign(target.y - y);
    route.push(tileKey(x, y));
  }
  const roadTiles = route.filter((key) => Boolean(state.roads[key])).length;
  const distance = route.length;
  const effectiveDistance = Math.max(1, distance - roadTiles * roadRules.roadDistanceDiscount);
  const speed = state.players[source.ownerId]?.research.unlocked.engineering
    ? roadRules.engineeringTilesPerTick
    : roadRules.baseTilesPerTick;
  return {
    distance,
    travelTicks: Math.max(0, Math.ceil(effectiveDistance / speed) - 1),
  };
};
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
const plotCenter = (plot: Plot) => ({
  x: plot.x + Math.floor(plot.size / 2),
  y: plot.y + Math.floor(plot.size / 2),
});
const pointInBufferedPlot = (plot: Plot, x: number, y: number, buffer = 0) =>
  x >= plot.x - buffer &&
  y >= plot.y - buffer &&
  x < plot.x + plot.size + buffer &&
  y < plot.y + plot.size + buffer;
const isForeignSettlementProtectedAt = (
  state: WorldState,
  ownerId: PlayerId,
  x: number,
  y: number,
) =>
  Object.values(state.players).some(
    (player) =>
      player.id !== ownerId &&
      pointInBufferedPlot(
        player.plot,
        x,
        y,
        threatDefinitions['raider-swarm'].settlementBufferTiles,
      ),
  );
const territoryIntersectsForeignSettlement = (
  state: WorldState,
  ownerId: PlayerId,
  key: string,
) => {
  const [cellXText, cellYText] = key.split(':');
  const minX = Number(cellXText) * TERRITORY_CELL_SIZE;
  const minY = Number(cellYText) * TERRITORY_CELL_SIZE;
  for (let x = minX; x < minX + TERRITORY_CELL_SIZE; x += 1)
    for (let y = minY; y < minY + TERRITORY_CELL_SIZE; y += 1)
      if (isForeignSettlementProtectedAt(state, ownerId, x, y)) return true;
  return false;
};
/** A permanent one-tile westward lane prevents any settlement center being enclosed by buildings. */
const isSettlementAccessTile = (state: WorldState, x: number, y: number) =>
  Object.values(state.players).some((player) => {
    const center = state.buildings[`center-${player.id}`];
    return Boolean(center && y === center.y && x >= player.plot.x && x < center.x);
  });
const reservedResourceOwner = (state: WorldState, x: number, y: number): PlayerId | undefined =>
  Object.values(state.players)
    .map((player) => ({ player, distance: manhattanDistance(plotCenter(player.plot), { x, y }) }))
    .filter(({ distance }) => distance <= GATHER_RANGE)
    .sort(
      (left, right) =>
        left.distance - right.distance || left.player.id.localeCompare(right.player.id),
    )[0]?.player.id;
/**
 * The deposit an extractor works, scanned in the same deterministic ring order as
 * manual gathering. Exhausted deposits and deposits reserved for a nearer starting
 * settlement are skipped, so automation cannot take what a click could not.
 */
export const extractableTile = (
  state: WorldState,
  building: Pick<Building, 'kind' | 'ownerId' | 'x' | 'y'>,
): { x: number; y: number } | undefined => {
  const extractor = extractorFor(building.kind);
  if (!extractor) return undefined;
  for (let distance = 0; distance <= extractor.range; distance += 1)
    for (let offsetX = -distance; offsetX <= distance; offsetX += 1) {
      const offsetY = distance - Math.abs(offsetX);
      const candidateX = building.x + offsetX;
      for (const candidateY of offsetY === 0
        ? [building.y]
        : [building.y - offsetY, building.y + offsetY]) {
        if (terrainAt(state.seed, candidateX, candidateY) !== extractor.terrain) continue;
        if (
          (state.minedTiles[tileKey(candidateX, candidateY)] ?? 0) >=
          resourceDefinitions[extractor.terrain].yield
        )
          continue;
        const reserved = reservedResourceOwner(state, candidateX, candidateY);
        if (reserved !== undefined && reserved !== building.ownerId) continue;
        return { x: candidateX, y: candidateY };
      }
    }
  return undefined;
};
const activityFor = (state: WorldState, ownerId: PlayerId): PlayerActivity =>
  state.playerActivity[ownerId] ?? { lastActiveTick: state.tick, raidEligibleTick: state.tick };
const isRaidEligible = (state: WorldState, ownerId: PlayerId) =>
  state.tick >= activityFor(state, ownerId).raidEligibleTick;
const isInactive = (state: WorldState, ownerId: PlayerId) =>
  state.tick - activityFor(state, ownerId).lastActiveTick >=
  threatDefinitions['raider-swarm'].inactiveAfterTicks;
const protectedHealthFloor = (state: WorldState, building: Building) =>
  isInactive(state, building.ownerId)
    ? Math.ceil(
        (building.maxHealth * threatDefinitions['raider-swarm'].inactiveHealthFloorPercent) / 100,
      )
    : 0;

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
 * A starter plot has to hold a whole settlement, so most of it must be open ground.
 * Lakes and ranges may still edge into it; they shape where a player builds rather than
 * whether they can build at all.
 */
const MIN_OPEN_PLOT_FRACTION = 0.875;
const isSettleablePlot = (seed: number, plot: Plot) => {
  let open = 0;
  for (let x = plot.x; x < plot.x + plot.size; x += 1)
    for (let y = plot.y; y < plot.y + plot.size; y += 1) if (isOpenTile(seed, x, y)) open += 1;
  return open >= plot.size ** 2 * MIN_OPEN_PLOT_FRACTION;
};

/**
 * Allocates the next unclaimed radial plot with a buildable center. The scan is
 * deterministic and the 12-tile spacing keeps the 8×8 settlement plots apart. Plots
 * walled in by water or mountains are skipped so a new player never spawns somewhere
 * they cannot build.
 */
const plotFor = (state: WorldState): Plot => {
  const claimed = Object.values(state.players).map((player) => player.plot);
  for (let ordinal = 0; ordinal < MAX_PLOT_CANDIDATE_ATTEMPTS; ordinal += 1) {
    const candidate = plotCandidate(ordinal);
    const centerX = candidate.x + candidate.size - 2;
    const centerY = candidate.y + candidate.size - 2;
    if (
      isOpenTile(state.seed, centerX, centerY) &&
      isSettleablePlot(state.seed, candidate) &&
      !claimed.some((plot) => plotsOverlap(plot, candidate))
    )
      return candidate;
  }
  throw new Error('World plot-allocation budget exhausted.');
};

export const initialCooperativeObjectives = (): WorldState['cooperativeObjectives'] =>
  Object.fromEntries(
    Object.values(cooperativeObjectiveDefinitions).map((definition) => [
      definition.id,
      {
        id: definition.id,
        totalContributed: 0,
        completedTick: null,
        contributionsBySettlement: {},
        contributionsByPlayer: {},
        rewardClaims: {},
        contributionHistory: [],
        rewardHistory: [],
      },
    ]),
  ) as unknown as WorldState['cooperativeObjectives'];

export const createWorld = (seed = 1, peaceful = true): WorldState => ({
  schemaVersion: 29,
  contentVersion: CONTENT_VERSION,
  seed,
  peaceful,
  randomState: createRandomState(seed),
  tick: 0,
  players: {},
  deletedPlayers: {},
  buildings: {},
  threats: {},
  scouts: {},
  transfers: [],
  settlements: {},
  logisticsLinks: {},
  roads: {},
  cooperativeObjectives: initialCooperativeObjectives(),
  playerActivity: {},
  onboardingReservations: {},
  sharedConstructionProjects: {},
  social: initialSocialState(),
  processedCommands: [],
  minedTiles: {},
});

export const joinPlayer = (state: WorldState, id: string): WorldEvent[] => {
  if (state.players[id] || state.deletedPlayers[id]) return [];
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
      unlocked: {
        metallurgy: false,
        'territorial-charter': false,
        engineering: false,
        stewardship: false,
      },
    },
    discoveries: {},
    lastSequence: 0,
  };
  state.playerActivity[id] = {
    lastActiveTick: state.tick,
    raidEligibleTick: state.tick + threatDefinitions['raider-swarm'].newPlayerProtectionTicks,
  };
  state.onboardingReservations[id] = {
    createdTick: state.tick,
    expiresTick: state.tick + onboardingRules.abandonedReservationTicks,
    securedTick: null,
  };
  const usedPlayerNames = new Set(Object.values(state.social.playerNames));
  const usedSettlementNames = new Set(Object.values(state.social.settlementNames));
  let ordinal = 1;
  while (
    usedPlayerNames.has(`Settler ${ordinal}`) ||
    usedSettlementNames.has(`Settlement ${ordinal}`)
  )
    ordinal += 1;
  state.social.playerNames[id] = `Settler ${ordinal}`;
  state.social.settlementNames[`settlement-${id}`] = `Settlement ${ordinal}`;
  state.social.blockedPlayers[id] = {};
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
    moveCooldown: 0,
  };
  return [{ type: 'playerJoined', playerId: typedId }];
};

const inPlot = (plot: Plot, x: number, y: number) =>
  x >= plot.x && y >= plot.y && x < plot.x + plot.size && y < plot.y + plot.size;
const distance = (a: Plot, x: number, y: number) =>
  Math.abs(a.x + Math.floor(a.size / 2) - x) + Math.abs(a.y + Math.floor(a.size / 2) - y);
export const plotTerritory = (plot: Plot): Record<string, true> => {
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

/** Finds a worked timber node a forester can restore, preferring the nearest stable tile. */
const renewableTile = (state: WorldState, building: Pick<Building, 'kind' | 'x' | 'y'>) => {
  const renewer = renewerFor(building.kind);
  if (!renewer) return undefined;
  for (let distance = 0; distance <= renewer.range; distance += 1)
    for (let offsetX = -distance; offsetX <= distance; offsetX += 1) {
      const offsetY = distance - Math.abs(offsetX);
      const candidates =
        offsetY === 0 ? [building.y] : [building.y - offsetY, building.y + offsetY];
      for (const candidateY of candidates) {
        const candidateX = building.x + offsetX;
        const key = tileKey(candidateX, candidateY);
        if (
          terrainAt(state.seed, candidateX, candidateY) === renewer.terrain &&
          (state.minedTiles[key] ?? 0) > 0
        )
          return { x: candidateX, y: candidateY };
      }
    }
  return undefined;
};

const foresterCycleTicks = (state: WorldState, building: Building) => {
  const renewer = renewerFor(building.kind)!;
  const besideWater = [
    [building.x + 1, building.y],
    [building.x - 1, building.y],
    [building.x, building.y + 1],
    [building.x, building.y - 1],
  ].some(([x, y]) => terrainAt(state.seed, x!, y!) === 'water');
  const fertileGrove =
    state.players[building.ownerId]?.discoveries[chunkKey(building.x, building.y)]?.kind ===
    'fertile-grove';
  return besideWater || fertileGrove ? renewer.waterBonusTicksPerUnit : renewer.ticksPerUnit;
};

const landmarkRewardFor = (kind: LandmarkId): Partial<Inventory> =>
  kind === 'ancient-ruin' ? { ingot: 1 } : kind === 'mountain-pass' ? { tool: 1 } : { wood: 2 };

const discoverChunk = (state: WorldState, player: PlayerState, key: string): WorldEvent[] => {
  if (player.discoveries[key]) return [];
  const [chunkXText, chunkYText] = key.split(':');
  const landmark = landmarkAtChunk(state.seed, Number(chunkXText), Number(chunkYText));
  if (!landmark) return [];
  const requestedReward = landmarkRewardFor(landmark.kind);
  const rewardAmount = Object.values(requestedReward).reduce((total, amount) => total + amount, 0);
  const reward =
    inventoryTotal(player.inventory) + rewardAmount <= INVENTORY_CAPACITY ? requestedReward : {};
  for (const [item, amount] of Object.entries(reward))
    player.inventory[item as ItemId] += amount ?? 0;
  player.discoveries[key] = {
    ...landmark,
    discoveredTick: state.tick,
    reward,
  };
  return [{ type: 'landmarkDiscovered', playerId: player.id, landmarkKind: landmark.kind }];
};
export const individualSettlementsFor = (players: Record<string, { id: PlayerId }>) =>
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
const visibleChunksFor = (
  player: PlayerState,
  ownedBuildings: readonly Building[],
  ownedScouts: readonly Scout[],
): Record<string, true> => {
  const visible: Record<string, true> = { [chunkKey(player.plot.x, player.plot.y)]: true };
  for (const building of ownedBuildings) {
    if (building.health <= 0) continue;
    const chunkX = Math.floor(building.x / 16);
    const chunkY = Math.floor(building.y / 16);
    for (let offsetX = -1; offsetX <= 1; offsetX += 1)
      for (let offsetY = -1; offsetY <= 1; offsetY += 1)
        visible[chunkKey(chunkX * 16 + offsetX * 16, chunkY * 16 + offsetY * 16)] = true;
  }
  for (const scout of ownedScouts) visible[chunkKey(scout.x, scout.y)] = true;
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
        isOpenTile(state.seed, tile.x, tile.y) &&
        !isForeignSettlementProtectedAt(state, target.ownerId, tile.x, tile.y) &&
        !Object.values(state.buildings).some(
          (building) => building.x === tile.x && building.y === tile.y,
        ),
    );
    if (candidate) return candidate;
  }
  return undefined;
};
const createBuildingRecord = (
  state: WorldState,
  ownerId: PlayerId,
  kind: SharedProjectBuildingKind,
  x: number,
  y: number,
): Building => {
  const definition = buildingDefinitions[kind];
  const id = buildingId(`${kind}-${state.tick}-${Object.keys(state.buildings).length}`);
  const building: Building = {
    id,
    kind,
    ownerId,
    x,
    y,
    health: definition.maxHealth,
    maxHealth: definition.maxHealth,
    progress: 0,
    constructionTicks: definition.constructionTicks,
    constructionMaterials: constructionMaterialsFor(kind),
    inventory: emptyInventory(),
    inventoryCapacity: definition.inventoryCapacity,
    populationCapacity: definition.populationCapacity,
    jobPriority: needsWorker(kind) ? 1 : 0,
    recipeId: defaultRecipeIdFor(kind),
    productionState: definition.constructionTicks > 0 ? 'constructing' : 'idle',
  };
  state.buildings[id] = building;
  return building;
};
const normalizeUserText = (value: string) => value.normalize('NFKC').replace(/\s+/gu, ' ').trim();
const foldedUserText = (value: string) => normalizeUserText(value).toLocaleLowerCase('en-US');
const containsModeratedTerm = (value: string) => {
  const folded = foldedUserText(value);
  return socialRules.moderatedTerms.some((term) => folded.includes(term));
};
const validDisplayName = (
  value: string,
  limits: { readonly min: number; readonly max: number },
) => {
  const length = [...value].length;
  return (
    length >= limits.min && length <= limits.max && /^[\p{L}\p{N}][\p{L}\p{N} .'-]*$/u.test(value)
  );
};

const removePlayerData = (
  state: WorldState,
  player: PlayerState,
  reason: NonNullable<DeletedPlayer['reason']>,
  removeOwnedSettlements: boolean,
) => {
  const ownedBuildingIds = new Set(
    Object.values(state.buildings)
      .filter((building) => building.ownerId === player.id)
      .map((building) => building.id),
  );
  for (const id of ownedBuildingIds) delete state.buildings[id];
  for (const [id, threat] of Object.entries(state.threats))
    if (ownedBuildingIds.has(threat.targetBuildingId)) delete state.threats[id];
  for (const [id, link] of Object.entries(state.logisticsLinks))
    if (
      link.ownerId === player.id ||
      ownedBuildingIds.has(link.sourceBuildingId) ||
      ownedBuildingIds.has(link.targetBuildingId)
    )
      delete state.logisticsLinks[id];
  for (const [id, scout] of Object.entries(state.scouts ?? {}))
    if (scout.ownerId === player.id) delete state.scouts?.[id];
  for (const [key, ownerId] of Object.entries(state.roads))
    if (ownerId === player.id) delete state.roads[key];

  for (const [id, settlement] of Object.entries(state.settlements)) {
    delete settlement.members[player.id];
    delete settlement.invitations[player.id];
    if (removeOwnedSettlements && settlement.ownerId === player.id) {
      for (const [projectId, project] of Object.entries(state.sharedConstructionProjects))
        if (project.settlementId === id) delete state.sharedConstructionProjects[projectId];
      state.social.messages = state.social.messages.filter(
        (message) => message.settlementId !== id,
      );
      delete state.settlements[id];
      delete state.social.settlementNames[id];
    }
  }

  let anonymizedOrdinal = 1;
  const usedNames = new Set(Object.values(state.social.playerNames).map(foldedUserText));
  let anonymizedName = `Deleted player ${anonymizedOrdinal}`;
  while (usedNames.has(foldedUserText(anonymizedName))) {
    anonymizedOrdinal += 1;
    anonymizedName = `Deleted player ${anonymizedOrdinal}`;
  }
  for (const message of state.social.messages)
    if (message.senderId === player.id) Object.assign(message, { senderName: anonymizedName });
  for (const report of state.social.reports)
    if (report.reportedMessage.senderId === player.id)
      Object.assign(report.reportedMessage, { senderName: anonymizedName });
  delete state.social.playerNames[player.id];
  delete state.social.blockedPlayers[player.id];
  delete state.social.lastChatTick[player.id];
  for (const blocked of Object.values(state.social.blockedPlayers)) delete blocked[player.id];

  delete state.players[player.id];
  delete state.playerActivity[player.id];
  delete state.onboardingReservations[player.id];
  state.deletedPlayers[player.id] = { id: player.id, deletedTick: state.tick, reason };
};

const hasSafeReclaimableStarterSettlement = (state: WorldState, player: PlayerState) => {
  const memberships = Object.values(state.settlements).filter(
    (settlement) => settlement.members[player.id],
  );
  const owned = memberships.filter((settlement) => settlement.ownerId === player.id);
  return (
    owned.length === 1 &&
    memberships.length === 1 &&
    Object.keys(owned[0]?.members ?? {}).length === 1
  );
};

const updateOnboardingReservations = (state: WorldState): WorldEvent[] => {
  const events: WorldEvent[] = [];
  for (const playerId of Object.keys(state.onboardingReservations).sort((left, right) =>
    left.localeCompare(right),
  )) {
    const reservation = state.onboardingReservations[playerId];
    const player = state.players[playerId];
    if (!reservation || !player) {
      delete state.onboardingReservations[playerId];
      continue;
    }
    if (reservation.securedTick !== null) continue;
    const completedSecuringBuilding = Object.values(state.buildings).some(
      (building) =>
        building.ownerId === player.id &&
        building.kind === onboardingRules.securingBuildingKind &&
        building.constructionTicks === 0,
    );
    if (completedSecuringBuilding) {
      reservation.securedTick = state.tick;
      continue;
    }
    if (state.tick < reservation.expiresTick) continue;
    if (!hasSafeReclaimableStarterSettlement(state, player)) {
      reservation.securedTick = state.tick;
      continue;
    }
    removePlayerData(state, player, 'abandoned-onboarding', true);
    events.push({ type: 'onboardingReservationReclaimed', playerId: player.id });
  }
  return events;
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
  if (!player)
    return reject(state.deletedPlayers[command.playerId] ? 'account-deleted' : 'unknown-player');
  if (!Number.isSafeInteger(command.sequence) || command.sequence < 1)
    return reject('out-of-order-command');
  if ('x' in command && (!Number.isSafeInteger(command.x) || !Number.isSafeInteger(command.y)))
    return reject('invalid-coordinate');
  if (state.processedCommands.includes(command.id)) return reject('duplicate-command');
  if (command.sequence <= player.lastSequence) return reject('out-of-order-command');
  const accept = (events: WorldEvent[]) => {
    player.lastSequence = command.sequence;
    state.playerActivity[player.id] = {
      ...(state.playerActivity[player.id] ?? {
        raidEligibleTick: state.tick + threatDefinitions['raider-swarm'].newPlayerProtectionTicks,
      }),
      lastActiveTick: state.tick,
    };
    const reservation = state.onboardingReservations[player.id];
    if (reservation?.securedTick === null)
      reservation.expiresTick = state.tick + onboardingRules.abandonedReservationTicks;
    state.processedCommands.push(command.id);
    // A permanent world cannot keep every command ID: the oldest entries leave the
    // idempotency window, where the per-player sequence check still rejects retries.
    while (state.processedCommands.length > worldRetention.processedCommands)
      state.processedCommands.shift();
    return { result: { accepted: true as const, commandId: command.id }, events };
  };
  if (command.type === 'gather') {
    if (distance(player.plot, command.x, command.y) > GATHER_RANGE) return reject('out-of-range');
    if (reservedResourceOwner(state, command.x, command.y) !== player.id)
      return reject('reserved-resource');
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
    const key = chunkKey(command.x, command.y);
    player.exploredChunks[key] = true;
    return accept(discoverChunk(state, player, key));
  }
  if (command.type === 'moveScout') {
    const scout = state.scouts?.[command.scoutId];
    if (!scout) return reject('unknown-scout');
    if (scout.ownerId !== player.id) return reject('unauthorized');
    if (Math.abs(scout.x - command.x) + Math.abs(scout.y - command.y) > 64)
      return reject('out-of-range');
    if (!isOpenTile(state.seed, command.x, command.y)) return reject('tile-not-buildable');
    scout.target = { x: command.x, y: command.y };
    return accept([]);
  }
  if (command.type === 'claimTerritory') {
    if (!player.research.unlocked['territorial-charter']) return reject('technology-locked');
    const key = territoryKey(command.x, command.y);
    if (!player.exploredChunks[chunkKey(command.x, command.y)]) return reject('not-explored');
    if (player.territoryCells[key] || isClaimedByOther(state, player.id, key))
      return reject('territory-claimed');
    if (territoryIntersectsForeignSettlement(state, player.id, key))
      return reject('protected-area');
    if (!territoryNeighbors(key).some((neighbor) => player.territoryCells[neighbor]))
      return reject('not-adjacent');
    player.territoryCells[key] = true;
    return accept([]);
  }
  if (command.type === 'placeRoad') {
    if (!player.research.unlocked.engineering) return reject('technology-locked');
    const key = tileKey(command.x, command.y);
    if (state.roads[key]) return reject('road-exists');
    if (!canBuildAt(state, player, command.x, command.y)) return reject('outside-plot');
    if (!isOpenTile(state.seed, command.x, command.y)) return reject('tile-not-buildable');
    if (
      Object.values(state.buildings).some(
        (building) => building.x === command.x && building.y === command.y,
      )
    )
      return reject('occupied');
    if (player.inventory.wood < roadRules.woodCost) return reject('insufficient-wood');
    player.inventory.wood -= roadRules.woodCost;
    state.roads[key] = player.id;
    return accept([{ type: 'roadPlaced', playerId: player.id }]);
  }
  if (command.type === 'research') {
    const technology = technologies[command.technologyId];
    if (player.research.unlocked[technology.id]) return reject('already-researched');
    if (player.research.activeTechnology) return reject('research-in-progress');
    if (
      'exclusiveGroup' in technology &&
      Object.values(technologies).some(
        (candidate) =>
          candidate.id !== technology.id &&
          'exclusiveGroup' in candidate &&
          candidate.exclusiveGroup === technology.exclusiveGroup &&
          player.research.unlocked[candidate.id],
      )
    )
      return reject('research-branch-locked');
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
  if (command.type === 'contributeToObjective') {
    const definition = cooperativeObjectiveDefinitions[command.objectiveId];
    const objective = state.cooperativeObjectives[command.objectiveId];
    if (!definition || !objective) return reject('unknown-objective');
    if (objective.completedTick !== null) return reject('objective-complete');
    const settlement = state.settlements[command.settlementId];
    if (!settlement) return reject('unknown-settlement');
    if (!settlement.members[player.id]) return reject('not-settlement-member');
    if (!Number.isSafeInteger(command.amount) || command.amount < 1)
      return reject('invalid-amount');
    if (objective.totalContributed + command.amount > definition.targetAmount)
      return reject('invalid-amount');
    const item = definition.contributionItem as ItemId;
    if (player.inventory[item] < command.amount) return reject('insufficient-resources');
    player.inventory[item] -= command.amount;
    objective.totalContributed += command.amount;
    objective.contributionsBySettlement[settlement.id] =
      (objective.contributionsBySettlement[settlement.id] ?? 0) + command.amount;
    objective.contributionsByPlayer[player.id] =
      (objective.contributionsByPlayer[player.id] ?? 0) + command.amount;
    objective.contributionHistory.push({
      commandId: command.id,
      playerId: player.id,
      settlementId: settlement.id,
      item,
      amount: command.amount,
      tick: state.tick,
    });
    const events: WorldEvent[] = [
      { type: 'objectiveContributed', playerId: player.id, objectiveId: objective.id },
    ];
    if (objective.totalContributed === definition.targetAmount) {
      objective.completedTick = state.tick;
      events.push({ type: 'objectiveCompleted', objectiveId: objective.id });
    }
    return accept(events);
  }
  if (command.type === 'claimObjectiveReward') {
    const definition = cooperativeObjectiveDefinitions[command.objectiveId];
    const objective = state.cooperativeObjectives[command.objectiveId];
    if (!definition || !objective) return reject('unknown-objective');
    if (objective.completedTick === null) return reject('objective-incomplete');
    if (!objective.contributionsByPlayer[player.id])
      return reject('objective-contribution-required');
    if (objective.rewardClaims[player.id]) return reject('reward-already-claimed');
    const rewardEntries = Object.entries(definition.reward) as Array<[ItemId, number]>;
    const rewardTotal = rewardEntries.reduce((total, [, amount]) => total + amount, 0);
    if (
      inventoryTotal(player.inventory) + rewardTotal > INVENTORY_CAPACITY ||
      rewardEntries.some(([item, amount]) => player.inventory[item] + amount > INVENTORY_CAPACITY)
    )
      return reject('inventory-full');
    for (const [item, amount] of rewardEntries) player.inventory[item] += amount;
    objective.rewardClaims[player.id] = command.id;
    objective.rewardHistory.push({
      commandId: command.id,
      playerId: player.id,
      reward: { ...definition.reward },
      tick: state.tick,
    });
    return accept([
      { type: 'objectiveRewardClaimed', playerId: player.id, objectiveId: objective.id },
    ]);
  }
  if (command.type === 'createSharedConstructionProject') {
    const settlement = state.settlements[command.settlementId];
    if (!settlement) return reject('unknown-settlement');
    const role = settlement.members[player.id];
    if (role !== 'owner' && role !== 'builder') return reject('settlement-permission-denied');
    const owner = state.players[settlement.ownerId];
    if (!owner) return reject('unknown-player');
    if (!canBuildAt(state, owner, command.x, command.y)) return reject('outside-plot');
    if (
      isSettlementAccessTile(state, command.x, command.y) ||
      isForeignSettlementProtectedAt(state, owner.id, command.x, command.y)
    )
      return reject('protected-area');
    if (!isOpenTile(state.seed, command.x, command.y)) return reject('tile-not-buildable');
    if (
      Object.values(state.buildings).some(
        (candidate) => candidate.x === command.x && candidate.y === command.y,
      ) ||
      Object.values(state.sharedConstructionProjects).some(
        (project) =>
          project.completedTick === null && project.x === command.x && project.y === command.y,
      )
    )
      return reject('occupied');
    const activeProjects = Object.values(state.sharedConstructionProjects).filter(
      (project) => project.settlementId === settlement.id && project.completedTick === null,
    );
    if (activeProjects.length >= MAX_ACTIVE_SHARED_PROJECTS_PER_SETTLEMENT)
      return reject('project-limit-reached');
    const definition = buildingDefinitions[command.buildingKind];
    if (definition.requiredTechnology && !owner.research.unlocked[definition.requiredTechnology])
      return reject('technology-locked');
    const projectId = command.id;
    state.sharedConstructionProjects[projectId] = {
      id: projectId,
      settlementId: settlement.id,
      createdBy: player.id,
      buildingKind: command.buildingKind,
      x: command.x,
      y: command.y,
      required: constructionMaterialsFor(command.buildingKind),
      contributed: emptyInventory(),
      createdTick: state.tick,
      completedTick: null,
      buildingId: null,
      contributionHistory: [],
    };
    return accept([
      {
        type: 'sharedProjectCreated',
        playerId: player.id,
        projectId,
      },
    ]);
  }
  if (command.type === 'contributeToSharedConstructionProject') {
    const project = state.sharedConstructionProjects[command.projectId];
    if (!project) return reject('unknown-project');
    if (project.completedTick !== null) return reject('project-complete');
    const settlement = state.settlements[project.settlementId];
    if (!settlement) return reject('unknown-settlement');
    if (!settlement.members[player.id]) return reject('not-settlement-member');
    if (!Number.isSafeInteger(command.amount) || command.amount < 1)
      return reject('invalid-amount');
    const remaining = project.required[command.item] - project.contributed[command.item];
    if (remaining < command.amount) return reject('invalid-amount');
    if (player.inventory[command.item] < command.amount) return reject('insufficient-resources');
    player.inventory[command.item] -= command.amount;
    project.contributed[command.item] += command.amount;
    project.contributionHistory.push({
      commandId: command.id,
      playerId: player.id,
      item: command.item,
      amount: command.amount,
      tick: state.tick,
    });
    const events: WorldEvent[] = [
      { type: 'sharedProjectContributed', playerId: player.id, projectId: project.id },
    ];
    if (inventoryItems.every((item) => project.contributed[item] === project.required[item])) {
      const building = createBuildingRecord(
        state,
        settlement.ownerId,
        project.buildingKind,
        project.x,
        project.y,
      );
      project.completedTick = state.tick;
      project.buildingId = building.id;
      events.push({
        type: 'sharedProjectCompleted',
        playerId: player.id,
        buildingId: building.id,
        projectId: project.id,
      });
    }
    return accept(events);
  }
  if (command.type === 'setPlayerName') {
    const name = normalizeUserText(command.name);
    if (!validDisplayName(name, socialRules.playerNameLength)) return reject('invalid-name');
    if (containsModeratedTerm(name)) return reject('content-rejected');
    if (
      Object.entries(state.social.playerNames).some(
        ([id, existing]) => id !== player.id && foldedUserText(existing) === foldedUserText(name),
      )
    )
      return reject('name-taken');
    state.social.playerNames[player.id] = name;
    return accept([{ type: 'playerNameChanged', playerId: player.id }]);
  }
  if (command.type === 'setSettlementName') {
    const settlement = state.settlements[command.settlementId];
    if (!settlement) return reject('unknown-settlement');
    if (settlement.ownerId !== player.id) return reject('settlement-permission-denied');
    const name = normalizeUserText(command.name);
    if (!validDisplayName(name, socialRules.settlementNameLength)) return reject('invalid-name');
    if (containsModeratedTerm(name)) return reject('content-rejected');
    if (
      Object.entries(state.social.settlementNames).some(
        ([id, existing]) =>
          id !== settlement.id && foldedUserText(existing) === foldedUserText(name),
      )
    )
      return reject('name-taken');
    state.social.settlementNames[settlement.id] = name;
    return accept([{ type: 'settlementNameChanged', playerId: player.id }]);
  }
  if (command.type === 'sendChatMessage') {
    const text = normalizeUserText(command.text);
    if (!text || [...text].length > socialRules.chatMessageMaxLength)
      return reject('invalid-message');
    if (containsModeratedTerm(text)) return reject('content-rejected');
    const lastChatTick = state.social.lastChatTick[player.id];
    if (lastChatTick !== undefined && state.tick - lastChatTick < socialRules.chatCooldownTicks)
      return reject('chat-rate-limited');
    if (command.channel === 'settlement') {
      const settlement = state.settlements[command.settlementId];
      if (!settlement) return reject('unknown-settlement');
      if (!settlement.members[player.id]) return reject('not-settlement-member');
    }
    state.social.messages.push({
      id: command.id,
      senderId: player.id,
      senderName: state.social.playerNames[player.id] ?? player.id,
      channel: command.channel,
      ...(command.channel === 'settlement' ? { settlementId: command.settlementId } : {}),
      text,
      tick: state.tick,
    });
    while (state.social.messages.length > socialRules.retainedMessages)
      state.social.messages.shift();
    state.social.lastChatTick[player.id] = state.tick;
    return accept([{ type: 'chatMessageSent', playerId: player.id }]);
  }
  if (command.type === 'setPlayerBlocked') {
    if (command.targetPlayerId === player.id) return reject('cannot-block-self');
    if (!state.players[command.targetPlayerId]) return reject('unknown-recipient');
    state.social.blockedPlayers[player.id] ??= {};
    if (command.blocked) state.social.blockedPlayers[player.id]![command.targetPlayerId] = true;
    else delete state.social.blockedPlayers[player.id]![command.targetPlayerId];
    return accept([
      {
        type: 'playerBlockChanged',
        playerId: player.id,
        targetPlayerId: command.targetPlayerId,
      },
    ]);
  }
  if (command.type === 'reportChatMessage') {
    const message = state.social.messages.find((candidate) => candidate.id === command.messageId);
    if (!message) return reject('unknown-message');
    if (
      state.social.reports.some(
        (report) =>
          report.reporterId === player.id && report.reportedMessage.id === command.messageId,
      )
    )
      return reject('already-reported');
    const reason = normalizeUserText(command.reason);
    if (!reason || [...reason].length > socialRules.reportReasonMaxLength)
      return reject('invalid-message');
    state.social.reports.push({
      id: command.id,
      reporterId: player.id,
      reportedMessage: structuredClone(message),
      reason,
      tick: state.tick,
      status: 'open',
    });
    while (state.social.reports.length > socialRules.retainedReports) state.social.reports.shift();
    return accept([{ type: 'chatMessageReported', playerId: player.id }]);
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
    while (state.transfers.length > worldRetention.transfers) state.transfers.shift();
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
    for (const project of Object.values(state.sharedConstructionProjects)) {
      if (project.settlementId !== settlement.id || !project.buildingId) continue;
      const building = state.buildings[project.buildingId];
      if (building) building.ownerId = command.targetPlayerId;
    }
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
  if (command.type === 'deleteAccount') {
    if (command.confirmation !== 'DELETE') return reject('account-deletion-confirmation-required');
    if (Object.values(state.settlements).some((settlement) => settlement.ownerId === player.id))
      return reject('cannot-delete-settlement-owner');

    const outcome = accept([{ type: 'playerDeleted', playerId: player.id }]);
    removePlayerData(state, player, 'account-deletion', false);
    return outcome;
  }
  if (command.type === 'createLogisticsLink') {
    const source = state.buildings[command.sourceBuildingId];
    const target = state.buildings[command.targetBuildingId];
    if (!source || !target) return reject('unknown-building');
    if (
      source.id === target.id ||
      !acceptedLinkSource(source.kind) ||
      !acceptedLinkTarget(target.kind) ||
      // Storage-to-storage links would only shuffle items between buffers.
      (isStorageBuilding(source.kind) && isStorageBuilding(target.kind)) ||
      !acceptsLogisticsItem(target, command.item) ||
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
      carrierId: `carrier-${id}`,
      routeDistance: Math.abs(source.x - target.x) + Math.abs(source.y - target.y),
      travelTicksRemaining: 0,
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
  if (isPlacementCommand(command)) {
    const placementKind = PLACEMENT_KINDS[command.type];
    if (
      Object.values(state.buildings).filter(
        (candidate) => candidate.ownerId === player.id && candidate.constructionTicks > 0,
      ).length >= MAX_ACTIVE_CONSTRUCTIONS_PER_PLAYER
    )
      return reject('construction-limit-reached');
    if (!canBuildAt(state, player, command.x, command.y)) return reject('outside-plot');
    if (
      isSettlementAccessTile(state, command.x, command.y) ||
      isForeignSettlementProtectedAt(state, player.id, command.x, command.y)
    )
      return reject('protected-area');
    if (!isOpenTile(state.seed, command.x, command.y)) return reject('tile-not-buildable');
    if (
      Object.values(state.buildings).some(
        (candidate) => candidate.x === command.x && candidate.y === command.y,
      ) ||
      Object.values(state.sharedConstructionProjects).some(
        (project) =>
          project.completedTick === null && project.x === command.x && project.y === command.y,
      )
    )
      return reject('occupied');
    const definition = buildingDefinitions[placementKind];
    if (definition.requiredTechnology && !player.research.unlocked[definition.requiredTechnology])
      return reject('technology-locked');
    // An extractor with no deposit in range would never produce, so refuse the site
    // instead of silently taking the wood for a building that cannot work.
    if (
      isExtractor(placementKind) &&
      !extractableTile(state, {
        kind: placementKind,
        ownerId: player.id,
        x: command.x,
        y: command.y,
      })
    )
      return reject('no-deposit-in-range');
    if (!canAffordConstruction(player.inventory, placementKind)) return reject('insufficient-wood');
    deductConstructionCost(player.inventory, placementKind);
    const placed = createBuildingRecord(state, player.id, placementKind, command.x, command.y);
    return accept([{ type: 'buildingPlaced', playerId: player.id, buildingId: placed.id }]);
  }
  const building = state.buildings[command.buildingId];
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
    if (!needsWorker(building.kind)) return reject('wrong-building');
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
  const events: WorldEvent[] = [];
  // Phase 1: advance-clock.
  let endPhase = beginPhase('advance-clock');
  state.tick += 1;
  events.push(...updateOnboardingReservations(state));
  endPhase();
  const staffedSmelters = new Set<BuildingId>();
  const staffedConstruction = new Set<BuildingId>();
  // Phase 2: research-and-population.
  endPhase = beginPhase('research-and-population');
  const buildingsByOwner = new Map<PlayerId, Building[]>();
  for (const building of Object.values(state.buildings)) {
    const owned = buildingsByOwner.get(building.ownerId) ?? [];
    owned.push(building);
    buildingsByOwner.set(building.ownerId, owned);
  }
  const scoutsByOwner = new Map<PlayerId, Scout[]>();
  for (const scout of Object.values(state.scouts ?? {})) {
    const owned = scoutsByOwner.get(scout.ownerId) ?? [];
    owned.push(scout);
    scoutsByOwner.set(scout.ownerId, owned);
  }
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
    const ownedBuildings = buildingsByOwner.get(player.id) ?? [];
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
        (building) => needsWorker(building.kind) && building.jobPriority > 0,
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
  }
  for (const scout of Object.values(state.scouts ?? {}).sort((left, right) =>
    left.id.localeCompare(right.id),
  )) {
    const target = scout.target;
    if (!target) continue;
    if ((scout.moveCooldown ?? 0) > 0) {
      scout.moveCooldown = (scout.moveCooldown ?? 0) - 1;
      continue;
    }
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
        (isOpenTile(state.seed, tile.x, tile.y) &&
          !Object.values(state.buildings).some(
            (building) => building.x === tile.x && building.y === tile.y,
          )),
    });
    const next = path.status === 'found' ? path.path[1] : undefined;
    if (next) {
      scout.x = next.x;
      scout.y = next.y;
      const roughTerrain = terrainAt(state.seed, next.x, next.y);
      scout.moveCooldown = state.roads[tileKey(next.x, next.y)]
        ? 0
        : roughTerrain === 'wood' || roughTerrain === 'ore'
          ? terrainRules.movement.roughTerrainDelayTicks
          : 0;
    }
    if ((scout.x === target.x && scout.y === target.y) || path.status !== 'found')
      delete scout.target;
    const owner = state.players[scout.ownerId];
    if (owner) {
      const key = chunkKey(scout.x, scout.y);
      owner.exploredChunks[key] = true;
      events.push(...discoverChunk(state, owner, key));
    }
  }
  for (const player of Object.values(state.players))
    player.visibleChunks = visibleChunksFor(
      player,
      buildingsByOwner.get(player.id) ?? [],
      scoutsByOwner.get(player.id) ?? [],
    );
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
      if (building.constructionTicks === 0) {
        const reservation = state.onboardingReservations[building.ownerId];
        if (
          reservation?.securedTick === null &&
          building.kind === onboardingRules.securingBuildingKind
        )
          reservation.securedTick = state.tick;
        events.push({
          type: 'buildingCompleted',
          buildingId: building.id,
          playerId: building.ownerId,
        });
      }
      continue;
    }
    const renewer = renewerFor(building.kind);
    if (renewer) {
      if (building.health !== building.maxHealth) building.productionState = 'damaged';
      else if (!staffedSmelters.has(building.id)) building.productionState = 'unassigned';
      else {
        const deposit = renewableTile(state, building);
        if (!deposit) {
          building.productionState = 'blocked-input';
          building.progress = 0;
        } else {
          building.productionState = 'working';
          if (building.progress === 0) building.progress = foresterCycleTicks(state, building);
          building.progress -= 1;
          if (building.progress === 0) {
            const key = tileKey(deposit.x, deposit.y);
            state.minedTiles[key] = Math.max(0, (state.minedTiles[key] ?? 0) - 1);
            if (state.minedTiles[key] === 0) delete state.minedTiles[key];
            events.push({
              type: 'resourceRegenerated',
              buildingId: building.id,
              playerId: building.ownerId,
            });
          }
        }
      }
      continue;
    }
    const extractor = extractorFor(building.kind);
    if (extractor) {
      if (building.health !== building.maxHealth) building.productionState = 'damaged';
      else if (!staffedSmelters.has(building.id)) building.productionState = 'unassigned';
      else if (
        !canStore(building.inventory, building.inventoryCapacity, extractor.item as ItemId, 1)
      ) {
        building.productionState = 'blocked-output';
        building.progress = 0;
      } else {
        const deposit = extractableTile(state, building);
        if (!deposit) {
          building.productionState = 'blocked-input';
          building.progress = 0;
        } else {
          building.productionState = 'working';
          if (building.progress === 0) building.progress = extractor.ticksPerUnit;
          building.progress -= 1;
          if (building.progress === 0) {
            state.minedTiles[tileKey(deposit.x, deposit.y)] =
              (state.minedTiles[tileKey(deposit.x, deposit.y)] ?? 0) + 1;
            building.inventory[extractor.item as ItemId] += 1;
            events.push({
              type: 'extracted',
              buildingId: building.id,
              playerId: building.ownerId,
            });
          }
        }
      }
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
      .filter(
        (building) =>
          building.constructionTicks === 0 &&
          building.health > 0 &&
          isRaidEligible(state, building.ownerId),
      )
      .sort((left, right) => left.id.localeCompare(right.id));
    const [nextRandomState, targetIndex] =
      targets.length > 0
        ? takeRandomIndex(state.randomState, targets.length)
        : [state.randomState, 0];
    state.randomState = nextRandomState;
    const target = targets[targetIndex];
    if (target) {
      target.health = Math.max(
        protectedHealthFloor(state, target),
        target.health - acidRain.damage,
      );
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
  const logisticsReservations: Array<{
    link: LogisticsLink;
    amount: number;
    travelTicks: number;
  }> = [];
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
    const route = carrierRouteFor(state, source, target);
    link.carrierId ??= `carrier-${link.id}`;
    link.routeDistance = route.distance;
    if ((link.travelTicksRemaining ?? 0) > 0) {
      link.travelTicksRemaining = (link.travelTicksRemaining ?? 0) - 1;
      link.status = 'in-transit';
      continue;
    }
    if (!acceptsLogisticsItem(target, link.item)) {
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
    logisticsReservations.push({ link, amount, travelTicks: route.travelTicks });
  }
  for (const { link, amount, travelTicks } of logisticsReservations) {
    const source = state.buildings[link.sourceBuildingId]!;
    const target = state.buildings[link.targetBuildingId]!;
    source.inventory[link.item] -= amount;
    target.inventory[link.item] += amount;
    link.travelTicksRemaining = travelTicks;
    link.status = 'transferred';
  }
  endPhase();
  // Phase 6: threat-spawning.
  endPhase = beginPhase('threat-spawning');
  const raider = threatDefinitions['raider-swarm'];
  if (!state.peaceful && state.tick % raider.spawnIntervalTicks === 0) {
    const activeThreatsByOwner = new Map<string, number>();
    for (const threat of Object.values(state.threats)) {
      const ownerId = state.buildings[threat.targetBuildingId]?.ownerId;
      if (ownerId) activeThreatsByOwner.set(ownerId, (activeThreatsByOwner.get(ownerId) ?? 0) + 1);
    }
    const targets = Object.values(state.buildings)
      .filter(
        (building) =>
          building.kind !== 'settlement-center' &&
          building.constructionTicks === 0 &&
          building.health > 0 &&
          isRaidEligible(state, building.ownerId) &&
          (!isInactive(state, building.ownerId) ||
            (activeThreatsByOwner.get(building.ownerId) ?? 0) < raider.maxInactiveThreatsPerPlayer),
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
      if (spawn) {
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
                (isOpenTile(state.seed, tile.x, tile.y) &&
                  !isForeignSettlementProtectedAt(state, target.ownerId, tile.x, tile.y) &&
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
                (isOpenTile(state.seed, tile.x, tile.y) &&
                  !isForeignSettlementProtectedAt(state, target.ownerId, tile.x, tile.y) &&
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
      (watchtowersByOwner.get(target.ownerId) ?? []).filter((tower) => {
        const overlooksMountain = [
          [tower.x + 1, tower.y],
          [tower.x - 1, tower.y],
          [tower.x, tower.y + 1],
          [tower.x, tower.y - 1],
        ].some(([x, y]) => terrainAt(state.seed, x!, y!) === 'mountain');
        const range =
          raider.watchtowerRange +
          (overlooksMountain ? terrainRules.watchtower.mountainRangeBonus : 0);
        return manhattanDistance(tower, threat) <= range;
      }).length * buildingDefinitions.watchtower.defenseDamage;
    threat.health -= defense;
    if (threat.health <= 0) {
      delete state.threats[threat.id];
      events.push({ type: 'threatDefeated', buildingId: target.id, threatId: threat.id });
      continue;
    }
    if (manhattanDistance(threat, target) <= 1 && state.tick % 10 === 0) {
      target.health = Math.max(protectedHealthFloor(state, target), target.health - threat.damage);
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

export const snapshot = (state: WorldState): WorldState => structuredClone(state);
export const stateHash = (state: WorldState): string => stableHash(snapshot(state));

/** Read-only invariant inspection for checkpoints, migration verification, and operations. */
export const inspectWorld = (state: WorldState): string[] => {
  const errors: string[] = [];
  const isNonNegativeInteger = (value: number) => Number.isSafeInteger(value) && value >= 0;
  if (typeof state.peaceful !== 'boolean') errors.push('world has an invalid peaceful flag');
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
  const hasKnownPlayer = (id: string) => Boolean(state.players[id] || state.deletedPlayers[id]);
  for (const [id, deleted] of Object.entries(state.deletedPlayers)) {
    if (
      deleted.id !== id ||
      state.players[id] ||
      !isNonNegativeInteger(deleted.deletedTick) ||
      deleted.deletedTick > state.tick ||
      (deleted.reason !== undefined &&
        deleted.reason !== 'account-deletion' &&
        deleted.reason !== 'abandoned-onboarding')
    )
      errors.push(`deleted player ${id} has an invalid tombstone`);
  }
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
    if (player.research.unlocked.engineering && player.research.unlocked.stewardship)
      errors.push(`player ${id} has conflicting research branches`);
    for (const [chunk, discovery] of Object.entries(player.discoveries)) {
      const [chunkXText, chunkYText] = chunk.split(':');
      const expected = landmarkAtChunk(state.seed, Number(chunkXText), Number(chunkYText));
      const expectedReward = expected ? landmarkRewardFor(expected.kind) : {};
      const rewardEntries = Object.entries(discovery.reward);
      const rewardIsValid =
        rewardEntries.length === 0 ||
        (rewardEntries.length === Object.keys(expectedReward).length &&
          rewardEntries.every(
            ([item, amount]) =>
              expectedReward[item as ItemId] === amount && isNonNegativeInteger(amount),
          ));
      if (
        !expected ||
        expected.kind !== discovery.kind ||
        expected.x !== discovery.x ||
        expected.y !== discovery.y ||
        !player.exploredChunks[chunk] ||
        !rewardIsValid ||
        !isNonNegativeInteger(discovery.discoveredTick) ||
        discovery.discoveredTick > state.tick
      )
        errors.push(`player ${id} has invalid landmark discovery ${chunk}`);
    }
    const activity = state.playerActivity[id];
    if (
      !activity ||
      !isNonNegativeInteger(activity.lastActiveTick) ||
      !isNonNegativeInteger(activity.raidEligibleTick) ||
      activity.lastActiveTick > state.tick
    )
      errors.push(`player ${id} has invalid activity protection state`);
    const reservation = state.onboardingReservations[id];
    if (
      !reservation ||
      !isNonNegativeInteger(reservation.createdTick) ||
      !isNonNegativeInteger(reservation.expiresTick) ||
      reservation.createdTick > state.tick ||
      reservation.expiresTick < reservation.createdTick ||
      (reservation.securedTick !== null &&
        (!isNonNegativeInteger(reservation.securedTick) || reservation.securedTick > state.tick))
    )
      errors.push(`player ${id} has an invalid onboarding reservation`);
  }
  for (const id of Object.keys(state.playerActivity))
    if (!state.players[id]) errors.push(`activity state has unknown player ${id}`);
  for (const id of Object.keys(state.onboardingReservations))
    if (!state.players[id]) errors.push(`onboarding reservation has unknown player ${id}`);
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
  if (state.transfers.length > worldRetention.transfers)
    errors.push('world state retains too many resource transfers');
  const transferIds = new Set<string>();
  for (const transfer of state.transfers) {
    if (transferIds.has(transfer.id)) errors.push(`duplicate transfer ${transfer.id}`);
    transferIds.add(transfer.id);
    if (!hasKnownPlayer(transfer.fromPlayerId) || !hasKnownPlayer(transfer.toPlayerId))
      errors.push(`transfer ${transfer.id} has an unknown participant`);
    if (!Number.isSafeInteger(transfer.amount) || transfer.amount < 1)
      errors.push(`transfer ${transfer.id} has an invalid amount`);
    if (!isNonNegativeInteger(transfer.tick))
      errors.push(`transfer ${transfer.id} has an invalid tick`);
  }
  if (state.processedCommands.length > worldRetention.processedCommands)
    errors.push('world state retains too many processed command identifiers');
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
  for (const [key, ownerId] of Object.entries(state.roads)) {
    const [xText, yText] = key.split(':');
    const x = Number(xText);
    const y = Number(yText);
    if (
      !state.players[ownerId] ||
      !Number.isSafeInteger(x) ||
      !Number.isSafeInteger(y) ||
      !isOpenTile(state.seed, x, y) ||
      occupied.has(key)
    )
      errors.push(`road ${key} has invalid state`);
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
  const activeProjectTiles = new Set<string>();
  for (const [id, project] of Object.entries(state.sharedConstructionProjects)) {
    if (project.id !== id) errors.push(`shared project key ${id} does not match its id`);
    const settlement = state.settlements[project.settlementId];
    const expected = constructionMaterialsFor(project.buildingKind);
    const historyTotals = emptyInventory();
    const contributionCommands = new Set<string>();
    for (const contribution of project.contributionHistory) {
      if (contributionCommands.has(contribution.commandId))
        errors.push(`shared project ${id} has duplicate contribution commands`);
      contributionCommands.add(contribution.commandId);
      if (
        !hasKnownPlayer(contribution.playerId) ||
        !inventoryItems.includes(contribution.item) ||
        !Number.isSafeInteger(contribution.amount) ||
        contribution.amount < 1 ||
        !isNonNegativeInteger(contribution.tick) ||
        contribution.tick > state.tick
      )
        errors.push(`shared project ${id} has invalid contribution history`);
      else historyTotals[contribution.item] += contribution.amount;
    }
    if (
      !settlement ||
      !hasKnownPlayer(project.createdBy) ||
      !Number.isSafeInteger(project.x) ||
      !Number.isSafeInteger(project.y) ||
      !isNonNegativeInteger(project.createdTick) ||
      project.createdTick > state.tick ||
      inventoryItems.some(
        (item) =>
          project.required[item] !== expected[item] ||
          project.contributed[item] !== historyTotals[item] ||
          project.contributed[item] > project.required[item],
      )
    )
      errors.push(`shared project ${id} has invalid project state`);
    const completed = inventoryItems.every(
      (item) => project.contributed[item] === project.required[item],
    );
    if (
      completed !== (project.completedTick !== null) ||
      completed !== (project.buildingId !== null) ||
      (project.completedTick !== null &&
        (!isNonNegativeInteger(project.completedTick) || project.completedTick > state.tick))
    )
      errors.push(`shared project ${id} has invalid completion state`);
    if (project.completedTick === null) {
      const position = tileKey(project.x, project.y);
      if (activeProjectTiles.has(position) || occupied.has(position))
        errors.push(`shared project ${id} has an occupied project tile`);
      activeProjectTiles.add(position);
    } else if (project.buildingId) {
      const building = state.buildings[project.buildingId];
      if (
        building &&
        (building.ownerId !== settlement?.ownerId ||
          building.kind !== project.buildingKind ||
          building.x !== project.x ||
          building.y !== project.y)
      )
        errors.push(`shared project ${id} has an inconsistent completed building`);
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
      !acceptedLinkSource(source.kind) ||
      !acceptedLinkTarget(target.kind) ||
      (isStorageBuilding(source.kind) && isStorageBuilding(target.kind)) ||
      !acceptsLogisticsItem(target, link.item)
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
        'in-transit',
      ].includes(link.status)
    )
      errors.push(`logistics link ${id} has an invalid status`);
    if (
      (link.carrierId !== undefined && link.carrierId !== `carrier-${id}`) ||
      (link.routeDistance !== undefined && !isNonNegativeInteger(link.routeDistance)) ||
      (link.travelTicksRemaining !== undefined && !isNonNegativeInteger(link.travelTicksRemaining))
    )
      errors.push(`logistics link ${id} has invalid carrier state`);
  }
  for (const definition of Object.values(cooperativeObjectiveDefinitions)) {
    const objective = state.cooperativeObjectives[definition.id];
    if (!objective) {
      errors.push(`cooperative objective ${definition.id} is missing`);
      continue;
    }
    const contributionTotal = objective.contributionHistory.reduce(
      (total, contribution) => total + contribution.amount,
      0,
    );
    const settlementTotal = Object.values(objective.contributionsBySettlement).reduce(
      (total, amount) => total + amount,
      0,
    );
    const playerTotal = Object.values(objective.contributionsByPlayer).reduce(
      (total, amount) => total + amount,
      0,
    );
    if (
      objective.id !== definition.id ||
      !isNonNegativeInteger(objective.totalContributed) ||
      objective.totalContributed > definition.targetAmount ||
      contributionTotal !== objective.totalContributed ||
      settlementTotal !== objective.totalContributed ||
      playerTotal !== objective.totalContributed
    )
      errors.push(`cooperative objective ${definition.id} has inconsistent contributions`);
    if (
      (objective.totalContributed === definition.targetAmount) !==
        (objective.completedTick !== null) ||
      (objective.completedTick !== null &&
        (!isNonNegativeInteger(objective.completedTick) || objective.completedTick > state.tick))
    )
      errors.push(`cooperative objective ${definition.id} has an invalid completion tick`);
    const contributionCommands = new Set<string>();
    for (const contribution of objective.contributionHistory) {
      if (contributionCommands.has(contribution.commandId))
        errors.push(`cooperative objective ${definition.id} has duplicate contribution commands`);
      contributionCommands.add(contribution.commandId);
      if (
        !hasKnownPlayer(contribution.playerId) ||
        !state.settlements[contribution.settlementId] ||
        contribution.item !== definition.contributionItem ||
        !Number.isSafeInteger(contribution.amount) ||
        contribution.amount < 1 ||
        !isNonNegativeInteger(contribution.tick) ||
        contribution.tick > state.tick
      )
        errors.push(`cooperative objective ${definition.id} has invalid contribution history`);
    }
    const rewardCommands = new Set<string>();
    for (const reward of objective.rewardHistory) {
      if (rewardCommands.has(reward.commandId))
        errors.push(`cooperative objective ${definition.id} has duplicate reward commands`);
      rewardCommands.add(reward.commandId);
      if (
        !hasKnownPlayer(reward.playerId) ||
        objective.rewardClaims[reward.playerId] !== reward.commandId ||
        !objective.contributionsByPlayer[reward.playerId] ||
        JSON.stringify(reward.reward) !== JSON.stringify(definition.reward) ||
        !isNonNegativeInteger(reward.tick) ||
        reward.tick > state.tick
      )
        errors.push(`cooperative objective ${definition.id} has invalid reward history`);
    }
    if (Object.keys(objective.rewardClaims).length !== objective.rewardHistory.length)
      errors.push(`cooperative objective ${definition.id} has inconsistent reward claims`);
  }
  const foldedPlayerNames = new Set<string>();
  for (const id of Object.keys(state.players)) {
    const name = state.social.playerNames[id];
    if (
      !name ||
      name !== normalizeUserText(name) ||
      !validDisplayName(name, socialRules.playerNameLength)
    )
      errors.push(`player ${id} has an invalid display name`);
    else if (foldedPlayerNames.has(foldedUserText(name)))
      errors.push(`player ${id} has a duplicate display name`);
    else foldedPlayerNames.add(foldedUserText(name));
    for (const blockedId of Object.keys(state.social.blockedPlayers[id] ?? {}))
      if (!state.players[blockedId] || blockedId === id)
        errors.push(`player ${id} has an invalid blocked player`);
  }
  for (const id of Object.keys(state.social.playerNames))
    if (!state.players[id]) errors.push(`social state has an unknown named player ${id}`);
  for (const id of Object.keys(state.social.blockedPlayers))
    if (!state.players[id]) errors.push(`social state has unknown block owner ${id}`);
  const foldedSettlementNames = new Set<string>();
  for (const id of Object.keys(state.settlements)) {
    const name = state.social.settlementNames[id];
    if (
      !name ||
      name !== normalizeUserText(name) ||
      !validDisplayName(name, socialRules.settlementNameLength)
    )
      errors.push(`settlement ${id} has an invalid display name`);
    else if (foldedSettlementNames.has(foldedUserText(name)))
      errors.push(`settlement ${id} has a duplicate display name`);
    else foldedSettlementNames.add(foldedUserText(name));
  }
  for (const id of Object.keys(state.social.settlementNames))
    if (!state.settlements[id]) errors.push(`social state has an unknown named settlement ${id}`);
  for (const [id, lastTick] of Object.entries(state.social.lastChatTick))
    if (!state.players[id] || !isNonNegativeInteger(lastTick) || lastTick > state.tick)
      errors.push(`player ${id} has an invalid chat rate-limit tick`);
  if (state.social.messages.length > socialRules.retainedMessages)
    errors.push('social state retains too many chat messages');
  const messageIds = new Set<string>();
  for (const message of state.social.messages) {
    if (messageIds.has(message.id)) errors.push(`duplicate chat message ${message.id}`);
    messageIds.add(message.id);
    if (
      !hasKnownPlayer(message.senderId) ||
      !message.id ||
      message.text !== normalizeUserText(message.text) ||
      !message.text ||
      [...message.text].length > socialRules.chatMessageMaxLength ||
      !isNonNegativeInteger(message.tick) ||
      message.tick > state.tick ||
      (message.channel === 'settlement' &&
        (!message.settlementId || !state.settlements[message.settlementId])) ||
      (message.channel === 'global' && message.settlementId !== undefined)
    )
      errors.push(`chat message ${message.id} is invalid`);
  }
  if (state.social.reports.length > socialRules.retainedReports)
    errors.push('social state retains too many chat reports');
  const reportIds = new Set<string>();
  const reporterMessages = new Set<string>();
  for (const report of state.social.reports) {
    const reporterMessage = `${report.reporterId}:${report.reportedMessage.id}`;
    if (reportIds.has(report.id) || reporterMessages.has(reporterMessage))
      errors.push(`duplicate chat report ${report.id}`);
    reportIds.add(report.id);
    reporterMessages.add(reporterMessage);
    if (
      !hasKnownPlayer(report.reporterId) ||
      !['open', 'resolved'].includes(report.status) ||
      report.reason !== normalizeUserText(report.reason) ||
      !report.reason ||
      [...report.reason].length > socialRules.reportReasonMaxLength ||
      !isNonNegativeInteger(report.tick) ||
      report.tick > state.tick
    )
      errors.push(`chat report ${report.id} is invalid`);
  }
  return errors;
};
