/**
 * Forward-only snapshot migration for persisted worlds, kept out of `world.ts` so the
 * live simulation reads as the current schema only. Every legacy shape the server has
 * ever written lives here, alongside the migrator that lifts it forward.
 *
 * Nothing here is reachable from a running world: it runs once, when a snapshot is read.
 */
import { type BuildingId, type PlayerId } from './commands.js';
import {
  CONTENT_VERSION,
  onboardingRules,
  resources as resourceDefinitions,
  threats as threatDefinitions,
  worldRetention,
} from '@kings/content';
import { createRandomState } from './random.js';
import { chunkKeyFor } from './spatial.js';
import {
  defaultRecipeIdFor,
  emptyInventory,
  individualSettlementsFor,
  initialCooperativeObjectives,
  initialSocialState,
  INVENTORY_CAPACITY,
  isProducer,
  logisticsCarrierCapacity,
  nearestOreTile,
  plotTerritory,
  terrainAt,
  tileKey,
  type Building,
  type Inventory,
  type LandmarkDiscovery,
  type LogisticsLink,
  type PlayerState,
  type Plot,
  type Population,
  type ResearchState,
  type SharedConstructionProject,
  type SocialState,
  type Threat,
  type WorldState,
} from './world.js';

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
type LegacyWorldBase = Omit<
  WorldState,
  | 'schemaVersion'
  | 'randomState'
  | 'peaceful'
  | 'cooperativeObjectives'
  | 'playerActivity'
  | 'sharedConstructionProjects'
  | 'social'
  | 'deletedPlayers'
  | 'onboardingReservations'
>;
interface Version14World extends LegacyWorldBase {
  schemaVersion: 14;
}
type PreFlowLogisticsLink = Omit<LogisticsLink, 'capacityPerTrip' | 'status'>;
type Version15LogisticsLink = Omit<PreFlowLogisticsLink, 'priority'>;
type LegacyBuildingWithoutRecipe = Omit<
  Building,
  'recipeId' | 'productionState' | 'constructionMaterials'
>;
interface Version16World extends Omit<
  WorldState,
  | 'schemaVersion'
  | 'buildings'
  | 'logisticsLinks'
  | 'peaceful'
  | 'cooperativeObjectives'
  | 'playerActivity'
  | 'sharedConstructionProjects'
  | 'social'
  | 'deletedPlayers'
  | 'onboardingReservations'
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
  | 'schemaVersion'
  | 'buildings'
  | 'logisticsLinks'
  | 'peaceful'
  | 'cooperativeObjectives'
  | 'playerActivity'
  | 'sharedConstructionProjects'
  | 'social'
  | 'deletedPlayers'
  | 'onboardingReservations'
> {
  schemaVersion: 17;
  buildings: Record<string, Omit<Building, 'productionState' | 'constructionMaterials'>>;
  logisticsLinks: Record<string, PreFlowLogisticsLink>;
}
interface Version18World extends Omit<
  WorldState,
  | 'schemaVersion'
  | 'buildings'
  | 'peaceful'
  | 'cooperativeObjectives'
  | 'playerActivity'
  | 'sharedConstructionProjects'
  | 'social'
  | 'deletedPlayers'
  | 'onboardingReservations'
> {
  schemaVersion: 18;
  buildings: Record<string, Omit<Building, 'constructionMaterials'>>;
}
interface Version19World extends Omit<
  WorldState,
  | 'schemaVersion'
  | 'peaceful'
  | 'cooperativeObjectives'
  | 'playerActivity'
  | 'sharedConstructionProjects'
  | 'social'
  | 'deletedPlayers'
  | 'onboardingReservations'
> {
  schemaVersion: 19;
}
interface Version20World extends Omit<
  WorldState,
  | 'schemaVersion'
  | 'cooperativeObjectives'
  | 'playerActivity'
  | 'sharedConstructionProjects'
  | 'social'
  | 'deletedPlayers'
  | 'onboardingReservations'
> {
  schemaVersion: 20;
}
interface Version21World extends Omit<
  WorldState,
  | 'schemaVersion'
  | 'playerActivity'
  | 'sharedConstructionProjects'
  | 'social'
  | 'deletedPlayers'
  | 'onboardingReservations'
> {
  schemaVersion: 21;
}
interface Version22World extends Omit<
  WorldState,
  | 'schemaVersion'
  | 'sharedConstructionProjects'
  | 'social'
  | 'deletedPlayers'
  | 'onboardingReservations'
> {
  schemaVersion: 22;
}
interface Version23World extends Omit<
  WorldState,
  'schemaVersion' | 'social' | 'deletedPlayers' | 'onboardingReservations'
> {
  schemaVersion: 23;
}
interface Version24World extends Omit<
  WorldState,
  'schemaVersion' | 'deletedPlayers' | 'onboardingReservations'
> {
  schemaVersion: 24;
}
/** Masonry adds two items, so every inventory written before it is two stacks short. */
type PreMasonryInventory = Omit<Inventory, 'stone' | 'brick'>;
type Version29Building = Omit<Building, 'tier' | 'upgradeTier' | 'inventory'> & {
  inventory: PreMasonryInventory;
};
/**
 * A version 29 link teleported its items and then sat out a cooldown standing in for the
 * carrier's return journey. Version 30 walks a real route instead, so the cooldown and the
 * per-tick throughput are replaced by a per-trip capacity and a planned route.
 */
type Version29LogisticsLink = Omit<LogisticsLink, 'capacityPerTrip' | 'route'> & {
  throughputPerTick: number;
  travelTicksRemaining?: number;
};
interface Version29Player extends Omit<PlayerState, 'inventory' | 'research'> {
  inventory: PreMasonryInventory;
  research: Omit<ResearchState, 'unlocked'> & {
    unlocked: Record<'metallurgy' | 'territorial-charter' | 'engineering' | 'stewardship', boolean>;
  };
}
interface Version29World extends Omit<
  WorldState,
  | 'schemaVersion'
  | 'contentVersion'
  | 'players'
  | 'buildings'
  | 'logisticsLinks'
  | 'carriers'
  | 'sharedConstructionProjects'
> {
  schemaVersion: 29;
  contentVersion: 4;
  players: Record<string, Version29Player>;
  buildings: Record<string, Version29Building>;
  logisticsLinks: Record<string, Version29LogisticsLink>;
  sharedConstructionProjects: Record<
    string,
    Omit<SharedConstructionProject, 'required' | 'contributed'> & {
      required: PreMasonryInventory;
      contributed: PreMasonryInventory;
    }
  >;
}
type Version30Player = Omit<PlayerState, 'gatherOrder' | 'initiative' | 'discoveries'> & {
  discoveries: Record<string, Omit<LandmarkDiscovery, 'choice'>>;
};
type Version30LogisticsLink = Omit<
  LogisticsLink,
  'targetMinimum' | 'targetMaximum' | 'deliveredTotal' | 'recentDeliveries'
>;
interface Version30World extends Omit<
  WorldState,
  'schemaVersion' | 'contentVersion' | 'players' | 'logisticsLinks'
> {
  schemaVersion: 30;
  contentVersion: 5;
  players: Record<string, Version30Player>;
  logisticsLinks: Record<string, Version30LogisticsLink>;
}
interface Version28Player extends Omit<PlayerState, 'discoveries' | 'research'> {
  research: Omit<ResearchState, 'unlocked'> & {
    unlocked: Record<'metallurgy' | 'territorial-charter', boolean>;
  };
}
interface Version28World extends Omit<
  WorldState,
  'schemaVersion' | 'contentVersion' | 'roads' | 'players'
> {
  schemaVersion: 28;
  contentVersion: 3;
  players: Record<string, Version28Player>;
}
interface Version27World extends Omit<Version28World, 'schemaVersion'> {
  schemaVersion: 27;
}
interface Version26World extends Omit<Version27World, 'schemaVersion' | 'contentVersion'> {
  schemaVersion: 26;
}
interface Version25World extends Omit<Version26World, 'schemaVersion' | 'onboardingReservations'> {
  schemaVersion: 25;
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
  ...emptyInventory(),
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
      { ...link, capacityPerTrip: logisticsCarrierCapacity, status: 'idle' },
    ]),
  ) as Record<string, LogisticsLink>;
const socialStateForExistingWorld = (
  players: WorldState['players'],
  settlements: WorldState['settlements'],
): SocialState => ({
  ...initialSocialState(),
  playerNames: Object.fromEntries(
    Object.keys(players)
      .sort((left, right) => left.localeCompare(right))
      .map((id, index) => [id, `Settler ${index + 1}`]),
  ),
  settlementNames: Object.fromEntries(
    Object.keys(settlements)
      .sort((left, right) => left.localeCompare(right))
      .map((id, index) => [id, `Settlement ${index + 1}`]),
  ),
  blockedPlayers: Object.fromEntries(Object.keys(players).map((id) => [id, {}])),
});
const onboardingReservationsForExistingWorld = (
  state: Pick<WorldState, 'tick' | 'buildings' | 'settlements' | 'playerActivity'> & {
    readonly players: Readonly<Record<string, Pick<PlayerState, 'id'>>>;
  },
): WorldState['onboardingReservations'] =>
  Object.fromEntries(
    Object.values(state.players).map((player) => {
      const memberships = Object.values(state.settlements).filter(
        (settlement) => settlement.members[player.id],
      );
      const ownsSoloStarter =
        memberships.length === 1 &&
        memberships[0]?.ownerId === player.id &&
        Object.keys(memberships[0].members).length === 1;
      const completedSecuringBuilding = Object.values(state.buildings).some(
        (building) =>
          building.ownerId === player.id &&
          building.kind === onboardingRules.securingBuildingKind &&
          building.constructionTicks === 0,
      );
      const createdTick = state.playerActivity[player.id]?.lastActiveTick ?? state.tick;
      return [
        player.id,
        {
          createdTick,
          expiresTick: state.tick + onboardingRules.abandonedReservationTicks,
          securedTick: completedSecuringBuilding || !ownsSoloStarter ? state.tick : null,
        },
      ];
    }),
  );
const withMasonryStacks = (inventory: PreMasonryInventory): Inventory => ({
  ...inventory,
  stone: 0,
  brick: 0,
});

/**
 * Version 30 adds the masonry chain, permanent building tiers, and carriers that walk. Every
 * existing building starts at tier one, and links keep their endpoints but drop the cooldown:
 * their route is left unplanned so the first tick surveys it under the shared route budget.
 */
const migrateVersion30 = (state: Version30World): WorldState => ({
  ...state,
  schemaVersion: 31,
  contentVersion: CONTENT_VERSION,
  players: Object.fromEntries(
    Object.entries(state.players).map(([id, player]) => [
      id,
      {
        ...player,
        initiative: null,
        discoveries: Object.fromEntries(
          Object.entries(player.discoveries).map(([key, discovery]) => [
            key,
            { ...discovery, reward: {}, choice: 'develop' as const },
          ]),
        ),
      },
    ]),
  ),
  logisticsLinks: Object.fromEntries(
    Object.entries(state.logisticsLinks).map(([id, link]) => [
      id,
      {
        ...link,
        targetMinimum: Math.min(
          INVENTORY_CAPACITY,
          state.buildings[link.targetBuildingId]?.inventoryCapacity ?? logisticsCarrierCapacity * 2,
        ),
        targetMaximum: Math.min(
          INVENTORY_CAPACITY,
          state.buildings[link.targetBuildingId]?.inventoryCapacity ?? logisticsCarrierCapacity * 2,
        ),
        deliveredTotal: 0,
        recentDeliveries: [],
      },
    ]),
  ),
});

const migrateVersion29 = (state: Version29World): WorldState =>
  migrateVersion30({
    ...state,
    schemaVersion: 30,
    contentVersion: 5,
    carriers: {},
    players: Object.fromEntries(
      Object.entries(state.players).map(([id, player]) => [
        id,
        {
          ...player,
          inventory: withMasonryStacks(player.inventory),
          research: {
            ...player.research,
            unlocked: { ...player.research.unlocked, masonry: false },
          },
        },
      ]),
    ),
    buildings: Object.fromEntries(
      Object.entries(state.buildings).map(([id, building]) => [
        id,
        {
          ...building,
          inventory: withMasonryStacks(building.inventory),
          constructionMaterials: withMasonryStacks(building.constructionMaterials),
          tier: 1 as const,
        },
      ]),
    ),
    logisticsLinks: Object.fromEntries(
      Object.entries(state.logisticsLinks).map(([id, link]) => {
        const { throughputPerTick, travelTicksRemaining, ...retained } = link;
        void throughputPerTick;
        void travelTicksRemaining;
        return [id, { ...retained, capacityPerTrip: logisticsCarrierCapacity }];
      }),
    ),
    sharedConstructionProjects: Object.fromEntries(
      Object.entries(state.sharedConstructionProjects).map(([id, project]) => [
        id,
        {
          ...project,
          required: withMasonryStacks(project.required),
          contributed: withMasonryStacks(project.contributed),
        },
      ]),
    ),
  } as unknown as Version30World);

const migrateVersion28 = (state: Version28World): WorldState =>
  migrateVersion29({
    ...state,
    schemaVersion: 29,
    contentVersion: 4,
    roads: {},
    players: Object.fromEntries(
      Object.entries(state.players).map(([id, player]) => [
        id,
        {
          ...player,
          discoveries: {},
          research: {
            ...player.research,
            unlocked: {
              ...player.research.unlocked,
              engineering: false,
              stewardship: false,
            },
          },
        },
      ]),
    ),
    logisticsLinks: Object.fromEntries(
      Object.entries(state.logisticsLinks).map(([id, link]) => [
        id,
        {
          ...link,
          carrierId: `carrier-${id}`,
          routeDistance: 0,
          travelTicksRemaining: 0,
        },
      ]),
    ),
  } as unknown as Version29World);

/** Version 27 worlds kept every command ID ever accepted; trim them to the retention window. */
const migrateVersion27 = (state: Version27World): WorldState =>
  migrateVersion28({
    ...state,
    schemaVersion: 28,
    processedCommands: state.processedCommands.slice(-worldRetention.processedCommands),
    transfers: state.transfers.slice(-worldRetention.transfers),
  });
const migrateVersion26 = (state: Version26World): WorldState =>
  migrateVersion27({
    ...state,
    schemaVersion: 27,
    contentVersion: 3,
  });
const migrateVersion25 = (state: Version25World): WorldState =>
  migrateVersion26({
    ...state,
    schemaVersion: 26,
    onboardingReservations: onboardingReservationsForExistingWorld(state),
  });
const migrateVersion24 = (state: Version24World): WorldState =>
  migrateVersion25({
    ...state,
    schemaVersion: 25,
    deletedPlayers: {},
  });
const migrateVersion23 = (state: Version23World): WorldState =>
  migrateVersion24({
    ...state,
    schemaVersion: 24,
    social: socialStateForExistingWorld(state.players, state.settlements),
  });
const migrateVersion22 = (state: Version22World): WorldState =>
  migrateVersion23({
    ...state,
    schemaVersion: 23,
    sharedConstructionProjects: {},
  });
const migrateVersion21 = (state: Version21World): WorldState =>
  migrateVersion22({
    ...state,
    schemaVersion: 22,
    playerActivity: Object.fromEntries(
      Object.keys(state.players).map((id) => [
        id,
        {
          lastActiveTick: state.tick,
          raidEligibleTick: state.tick + threatDefinitions['raider-swarm'].newPlayerProtectionTicks,
        },
      ]),
    ),
  });
const migrateVersion20 = (state: Version20World): WorldState =>
  migrateVersion21({
    ...state,
    schemaVersion: 21,
    cooperativeObjectives: initialCooperativeObjectives(),
  });
const migrateVersion17 = (state: Version17World): WorldState =>
  migrateVersion20({
    ...state,
    schemaVersion: 20,
    peaceful: true,
    buildings: withEmptyConstructionMaterials(withProductionStates(state.buildings)),
    logisticsLinks: withFlowControls(state.logisticsLinks),
  });
const migrateVersion18 = (state: Version18World): WorldState =>
  migrateVersion20({
    ...state,
    schemaVersion: 20,
    peaceful: true,
    buildings: withEmptyConstructionMaterials(state.buildings),
  });
const migrateVersion19 = (state: Version19World): WorldState =>
  migrateVersion20({ ...state, schemaVersion: 20, peaceful: true });
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

/**
 * Snapshots older than version 11 are lifted to version 11 first and then handed to the
 * version-11 migrator, so each of these only has to describe the fields its own version
 * was missing. They were inline in the version dispatch; naming them keeps that dispatch
 * a flat table.
 */
const migrateVersion10 = (legacy: Version10World): WorldState =>
  migrateToCurrentSchema({
    ...legacy,
    schemaVersion: 11,
    threats: withThreatPositions(legacy.threats, legacy.buildings),
  });

const migrateVersion9 = (legacy: Version9World): WorldState =>
  migrateToCurrentSchema({
    ...legacy,
    schemaVersion: 11,
    players: withLaborFields(legacy.players),
    buildings: withJobPriorities(legacy.buildings),
    threats: withThreatPositions(legacy.threats, legacy.buildings),
  });

const migrateVersion8 = (legacy: Version8World): WorldState =>
  migrateToCurrentSchema({
    ...legacy,
    schemaVersion: 11,
    logisticsLinks: {},
    players: withLaborFields(legacy.players),
    buildings: withJobPriorities(legacy.buildings),
    threats: withThreatPositions(legacy.threats, legacy.buildings),
  });

const migrateVersion7 = (legacy: Version7World): WorldState =>
  migrateToCurrentSchema({
    ...legacy,
    schemaVersion: 11,
    settlements: individualSettlementsFor(legacy.players),
    logisticsLinks: {},
    players: withLaborFields(legacy.players),
    buildings: withJobPriorities(legacy.buildings),
    threats: withThreatPositions(legacy.threats, legacy.buildings),
  });

const migrateVersion6 = (legacy: Version6World): WorldState =>
  migrateToCurrentSchema({
    ...legacy,
    schemaVersion: 11,
    transfers: [],
    settlements: individualSettlementsFor(legacy.players),
    logisticsLinks: {},
    players: withLaborFields(legacy.players),
    buildings: withJobPriorities(legacy.buildings),
    threats: withThreatPositions(legacy.threats, legacy.buildings),
  });

const migrateVersion5 = (legacy: Version5World): WorldState =>
  migrateToCurrentSchema({
    ...legacy,
    schemaVersion: 11,
    threats: {},
    transfers: [],
    settlements: individualSettlementsFor(legacy.players),
    logisticsLinks: {},
    players: withLaborFields(legacy.players),
    buildings: withJobPriorities(legacy.buildings),
  });

/** Research, territory, and the explored home chunk all arrive with version 5. */
const withResearchAndTerritory = (population: Population) => (player: LegacyPlayer) => ({
  ...player,
  population,
  exploredChunks: { [chunkKeyFor(player.plot.x, player.plot.y)]: true },
  territoryCells: plotTerritory(player.plot),
  research: {
    activeTechnology: null,
    ticksRemaining: 0,
    unlocked: { metallurgy: false, 'territorial-charter': false },
  },
});

const migrateVersion4 = (legacy: Version4World): WorldState =>
  migrateToCurrentSchema({
    ...legacy,
    schemaVersion: 11,
    threats: {},
    transfers: [],
    settlements: individualSettlementsFor(legacy.players),
    logisticsLinks: {},
    players: Object.fromEntries(
      Object.entries(legacy.players).map(([id, player]) => [
        id,
        withResearchAndTerritory({
          ...player.population,
          employed: 0,
          unemployed: player.population.total,
        })(player),
      ]),
    ),
    buildings: withJobPriorities(legacy.buildings),
  });

/** Before version 4 a settlement always held exactly its two starting residents. */
const startingPopulation: Population = {
  total: 2,
  capacity: 2,
  satisfaction: 100,
  employed: 0,
  unemployed: 2,
};

const migrateVersion3 = (legacy: Version3World): WorldState =>
  migrateToCurrentSchema({
    ...legacy,
    schemaVersion: 11,
    threats: {},
    transfers: [],
    settlements: individualSettlementsFor(legacy.players),
    logisticsLinks: {},
    players: Object.fromEntries(
      Object.entries(legacy.players).map(([id, player]) => [
        id,
        withResearchAndTerritory(startingPopulation)(player),
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

const migrateVersion2 = (legacy: Version2World): WorldState =>
  migrateToCurrentSchema({
    ...legacy,
    schemaVersion: 11,
    threats: {},
    transfers: [],
    settlements: individualSettlementsFor(legacy.players),
    logisticsLinks: {},
    players: Object.fromEntries(
      Object.entries(legacy.players).map(([id, player]) => [
        id,
        withResearchAndTerritory(startingPopulation)(player),
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

/**
 * Which migrator lifts a given snapshot version to the current schema. Each entry casts
 * its own argument, because a version number is only a runtime fact: the cast is the point
 * where an untrusted snapshot is claimed to match the shape its version recorded.
 *
 * Version 16 is the one step that does not chain onward by itself, so it names both.
 */
const SNAPSHOT_MIGRATIONS: Record<number, (candidate: unknown) => WorldState> = {
  31: (candidate) => candidate as WorldState,
  30: (candidate) => migrateVersion30(candidate as Version30World),
  29: (candidate) => migrateVersion29(candidate as Version29World),
  28: (candidate) => migrateVersion28(candidate as Version28World),
  27: (candidate) => migrateVersion27(candidate as Version27World),
  26: (candidate) => migrateVersion26(candidate as Version26World),
  25: (candidate) => migrateVersion25(candidate as Version25World),
  24: (candidate) => migrateVersion24(candidate as Version24World),
  23: (candidate) => migrateVersion23(candidate as Version23World),
  22: (candidate) => migrateVersion22(candidate as Version22World),
  21: (candidate) => migrateVersion21(candidate as Version21World),
  20: (candidate) => migrateVersion20(candidate as Version20World),
  19: (candidate) => migrateVersion19(candidate as Version19World),
  18: (candidate) => migrateVersion18(candidate as Version18World),
  17: (candidate) => migrateVersion17(candidate as Version17World),
  16: (candidate) => migrateVersion17(migrateVersion16(candidate as Version16World)),
  15: (candidate) => migrateVersion15(candidate as Version15World),
  14: (candidate) => migrateVersion14(candidate as Version14World),
  13: (candidate) => migrateVersion13(candidate as Version13World),
  12: (candidate) => migrateVersion12(candidate as Version12World),
  11: (candidate) => migrateToCurrentSchema(candidate as Version11World),
  10: (candidate) => migrateVersion10(candidate as Version10World),
  9: (candidate) => migrateVersion9(candidate as Version9World),
  8: (candidate) => migrateVersion8(candidate as Version8World),
  7: (candidate) => migrateVersion7(candidate as Version7World),
  6: (candidate) => migrateVersion6(candidate as Version6World),
  5: (candidate) => migrateVersion5(candidate as Version5World),
  4: (candidate) => migrateVersion4(candidate as Version4World),
  3: (candidate) => migrateVersion3(candidate as Version3World),
  2: (candidate) => migrateVersion2(candidate as Version2World),
};

/**
 * The content version each schema was written for. Snapshots from version 27 onwards record
 * their own content version, and a snapshot that does not match its schema's row is refused
 * rather than reinterpreted under different rules.
 *
 * Additive content — new items, buildings, recipes, or technologies — can be migrated, which
 * is why each older schema keeps its row. A content change that moves deterministic world
 * generation cannot: mountains did that twice, and the correct response is to drop the rows
 * for every earlier schema so those worlds are rejected instead of having terrain shifted
 * underneath their settlements.
 */
const SNAPSHOT_CONTENT_VERSIONS: Readonly<Record<number, number>> = {
  27: 3,
  28: 3,
  29: 4,
  30: 5,
  31: CONTENT_VERSION,
};

/** Forward-only snapshot migration kept inside the platform-independent simulation. */
export const deserializeWorld = (raw: unknown): WorldState => {
  const candidate = structuredClone(raw) as { schemaVersion?: number; contentVersion?: number };
  const expectedContentVersion =
    candidate.schemaVersion === undefined
      ? undefined
      : SNAPSHOT_CONTENT_VERSIONS[candidate.schemaVersion];
  if (
    candidate.schemaVersion !== undefined &&
    candidate.schemaVersion >= 27 &&
    candidate.contentVersion !== expectedContentVersion
  )
    throw new Error(
      `Unsupported world content version: ${String(candidate.contentVersion)}; expected ${String(expectedContentVersion ?? CONTENT_VERSION)}`,
    );
  const migrate =
    candidate.schemaVersion === undefined
      ? undefined
      : SNAPSHOT_MIGRATIONS[candidate.schemaVersion];
  if (!migrate)
    throw new Error(
      `Unsupported world snapshot schema version: ${String(candidate.schemaVersion)}`,
    );
  return migrate(candidate);
};
