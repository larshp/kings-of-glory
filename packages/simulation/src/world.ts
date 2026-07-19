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
  technologies,
  threats as threatDefinitions,
  type TechnologyId,
} from '@kings/content';
import { findPath, manhattanDistance } from '@kings/pathfinding';
import { stableHash } from './hash.js';

export interface Inventory {
  ore: number;
  wood: number;
  ingot: number;
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
  territoryCells: Record<string, true>;
  research: ResearchState;
  lastSequence: number;
}
export interface Building {
  id: BuildingId;
  kind: 'settlement-center' | 'smelter' | 'storage' | 'housing' | 'watchtower';
  ownerId: PlayerId;
  x: number;
  y: number;
  health: number;
  maxHealth: number;
  progress: number;
  constructionTicks: number;
  inventory: Inventory;
  inventoryCapacity: number;
  populationCapacity: number;
  jobPriority: 0 | 1 | 2 | 3;
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
  item: 'ore';
}
export interface WorldState {
  schemaVersion: 11;
  seed: number;
  tick: number;
  players: Record<string, PlayerState>;
  buildings: Record<string, Building>;
  threats: Record<string, Threat>;
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
  threatId?: string;
  targetPlayerId?: PlayerId;
}

const INVENTORY_CAPACITY = 100;
const ORE_PER_NODE = 10;
const CHUNK_SIZE = 16;
const TERRITORY_CELL_SIZE = 8;
const emptyInventory = (): Inventory => ({ ore: 0, wood: 0, ingot: 0 });
const tileKey = (x: number, y: number) => `${x}:${y}`;
const terrainNoise = (seed: number, x: number, y: number) =>
  Math.abs(Math.imul(seed ^ x, 73856093) ^ Math.imul(y, 19349663)) % 23;
export const terrainAt = (seed: number, x: number, y: number): 'grass' | 'water' | 'ore' => {
  const value = terrainNoise(seed, x, y);
  if (value === 0) return 'water';
  return value % 4 === 0 ? 'ore' : 'grass';
};
const inventoryTotal = (inventory: Inventory) => inventory.ore + inventory.wood + inventory.ingot;
const woodCostFor = (kind: Building['kind']) => (kind === 'smelter' ? 3 : 2);
const canStore = (inventory: Inventory, capacity: number, item: ItemId, amount: number) =>
  Number.isInteger(amount) &&
  amount > 0 &&
  inventoryTotal(inventory) + amount <= capacity &&
  inventory[item] + amount <= INVENTORY_CAPACITY;
const floorDiv = (value: number, divisor: number) => Math.floor(value / divisor);
const chunkKey = (x: number, y: number) => `${floorDiv(x, CHUNK_SIZE)}:${floorDiv(y, CHUNK_SIZE)}`;
const territoryKey = (x: number, y: number) =>
  `${floorDiv(x, TERRITORY_CELL_SIZE)}:${floorDiv(y, TERRITORY_CELL_SIZE)}`;
const territoryNeighbors = (key: string) => {
  const [xText, yText] = key.split(':');
  const x = Number(xText);
  const y = Number(yText);
  return [`${x + 1}:${y}`, `${x - 1}:${y}`, `${x}:${y + 1}`, `${x}:${y - 1}`];
};

const plotFor = (ordinal: number): Plot => {
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

export const createWorld = (seed = 1): WorldState => ({
  schemaVersion: 11,
  seed,
  tick: 0,
  players: {},
  buildings: {},
  threats: {},
  transfers: [],
  settlements: {},
  logisticsLinks: {},
  processedCommands: [],
  minedTiles: {},
});

export const joinPlayer = (state: WorldState, id: string): WorldEvent[] => {
  if (state.players[id]) return [];
  const typedId = playerId(id);
  const plot = plotFor(Object.keys(state.players).length);
  state.players[id] = {
    id: typedId,
    plot,
    inventory: { ore: 0, wood: 5, ingot: 0 },
    population: { total: 2, capacity: 2, satisfaction: 100, employed: 0, unemployed: 2 },
    exploredChunks: { [chunkKey(plot.x, plot.y)]: true },
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
  state.buildings[centerId] = {
    id: centerId,
    kind: 'settlement-center',
    ownerId: typedId,
    x: plot.x + plot.size - 2,
    y: plot.y + plot.size - 2,
    health: 25,
    maxHealth: 25,
    progress: 0,
    constructionTicks: 0,
    inventory: emptyInventory(),
    inventoryCapacity: INVENTORY_CAPACITY,
    populationCapacity: 2,
    jobPriority: 0,
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
  if (state.processedCommands.includes(command.id)) return reject('duplicate-command');
  if (command.sequence <= player.lastSequence) return reject('out-of-order-command');
  const accept = (events: WorldEvent[]) => {
    player.lastSequence = command.sequence;
    state.processedCommands.push(command.id);
    return { result: { accepted: true as const, commandId: command.id }, events };
  };
  if (command.type === 'gather') {
    if (distance(player.plot, command.x, command.y) > 8) return reject('out-of-range');
    const key = tileKey(command.x, command.y);
    if (terrainAt(state.seed, command.x, command.y) === 'water') return reject('resource-depleted');
    if ((state.minedTiles[key] ?? 0) >= ORE_PER_NODE) return reject('resource-depleted');
    if (inventoryTotal(player.inventory) >= INVENTORY_CAPACITY) return reject('inventory-full');
    state.minedTiles[key] = (state.minedTiles[key] ?? 0) + 1;
    player.inventory.ore += 1;
    return accept([{ type: 'gathered', playerId: player.id }]);
  }
  if (command.type === 'explore') {
    if (distance(player.plot, command.x, command.y) > 64) return reject('out-of-range');
    player.exploredChunks[chunkKey(command.x, command.y)] = true;
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
    if (player.inventory.ingot < (technology.cost.ingot ?? 0)) return reject('insufficient-ore');
    player.inventory.ingot -= technology.cost.ingot ?? 0;
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
  if (command.type === 'createLogisticsLink') {
    const source = state.buildings[command.sourceBuildingId];
    const target = state.buildings[command.targetBuildingId];
    if (!source || !target) return reject('unknown-building');
    if (
      source.id === target.id ||
      source.kind !== 'storage' ||
      target.kind !== 'smelter' ||
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
  const isPlacement =
    command.type === 'placeSmelter' ||
    command.type === 'placeStorage' ||
    command.type === 'placeHousing' ||
    command.type === 'placeWatchtower';
  const building =
    command.type === 'placeSmelter' ||
    command.type === 'placeStorage' ||
    command.type === 'placeHousing' ||
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
        : command.type === 'placeStorage'
          ? 'storage'
          : command.type === 'placeHousing'
            ? 'housing'
            : 'watchtower';
    const woodCost = woodCostFor(kind);
    if (player.inventory.wood < woodCost) return reject('insufficient-wood');
    const id = buildingId(`${kind}-${state.tick}-${Object.keys(state.buildings).length}`);
    player.inventory.wood -= woodCost;
    state.buildings[id] = {
      id,
      kind,
      ownerId: player.id,
      x: command.x,
      y: command.y,
      health: kind === 'smelter' ? 10 : 15,
      maxHealth: kind === 'smelter' ? 10 : 15,
      progress: 0,
      constructionTicks: kind === 'smelter' ? 10 : 5,
      inventory: emptyInventory(),
      inventoryCapacity: kind === 'smelter' ? 20 : kind === 'storage' ? 200 : 0,
      populationCapacity: kind === 'housing' ? 4 : 0,
      jobPriority: kind === 'smelter' ? 1 : 0,
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
    const refund = woodCostFor(building.kind);
    if (!owner || !canStore(owner.inventory, INVENTORY_CAPACITY, 'wood', refund))
      return reject('inventory-full');
    delete state.buildings[building.id];
    owner.inventory.wood += refund;
    return accept([{ type: 'buildingCancelled', playerId: player.id, buildingId: building.id }]);
  }
  if (command.type === 'demolish') {
    if (building.kind === 'settlement-center') return reject('cannot-demolish');
    if (building.constructionTicks > 0) return reject('construction-incomplete');
    if (
      inventoryTotal(player.inventory) + inventoryTotal(building.inventory) > INVENTORY_CAPACITY ||
      player.inventory.ore + building.inventory.ore > INVENTORY_CAPACITY ||
      player.inventory.wood + building.inventory.wood > INVENTORY_CAPACITY ||
      player.inventory.ingot + building.inventory.ingot > INVENTORY_CAPACITY
    )
      return reject('inventory-full');
    player.inventory.ore += building.inventory.ore;
    player.inventory.wood += building.inventory.wood;
    player.inventory.ingot += building.inventory.ingot;
    delete state.buildings[building.id];
    return accept([{ type: 'buildingDemolished', playerId: player.id, buildingId: building.id }]);
  }
  if (command.type === 'setJobPriority') {
    if (building.kind !== 'smelter') return reject('wrong-building');
    building.jobPriority = command.priority;
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
    if (building.inventory.ore < 1) return reject('insufficient-ore');
    if (!canStore(building.inventory, building.inventoryCapacity, 'ingot', 1))
      return reject('inventory-full');
    building.inventory.ore -= 1;
    building.progress = 3;
    return accept([]);
  }
  building.health = Math.min(building.maxHealth, building.health + 2);
  return accept([{ type: 'repaired', playerId: player.id, buildingId: building.id }]);
};

export const advanceTick = (state: WorldState): WorldEvent[] => {
  state.tick += 1;
  const events: WorldEvent[] = [];
  const staffedSmelters = new Set<BuildingId>();
  for (const player of Object.values(state.players)) {
    if (player.research.activeTechnology) {
      player.research.ticksRemaining -= 1;
      if (player.research.ticksRemaining === 0) {
        player.research.unlocked[player.research.activeTechnology] = true;
        player.research.activeTechnology = null;
      }
    }
    player.population.capacity = Object.values(state.buildings)
      .filter((building) => building.ownerId === player.id && building.constructionTicks === 0)
      .reduce((capacity, building) => capacity + building.populationCapacity, 0);
    if (
      state.tick % 200 === 0 &&
      player.population.total < player.population.capacity &&
      player.population.satisfaction >= 50
    )
      player.population.total += 1;
    const smelters = Object.values(state.buildings)
      .filter(
        (building) =>
          building.ownerId === player.id &&
          building.kind === 'smelter' &&
          building.constructionTicks === 0 &&
          building.jobPriority > 0,
      )
      .sort(
        (left, right) => right.jobPriority - left.jobPriority || left.id.localeCompare(right.id),
      );
    const staffed = smelters.slice(0, player.population.total);
    player.population.employed = staffed.length;
    player.population.unemployed = player.population.total - staffed.length;
    const shelterSatisfaction = player.population.capacity >= player.population.total ? 60 : 0;
    const workSatisfaction =
      player.population.total === 0
        ? 40
        : Math.floor((player.population.employed * 40) / player.population.total);
    player.population.satisfaction = shelterSatisfaction + workSatisfaction;
    for (const smelter of staffed) staffedSmelters.add(smelter.id);
  }
  for (const building of Object.values(state.buildings)) {
    if (building.constructionTicks > 0) {
      building.constructionTicks -= 1;
      if (building.constructionTicks === 0)
        events.push({
          type: 'buildingCompleted',
          buildingId: building.id,
          playerId: building.ownerId,
        });
      continue;
    }
    const canWork = building.kind !== 'smelter' || staffedSmelters.has(building.id);
    if (canWork && building.progress > 0) {
      building.progress -= 1;
      if (building.progress === 0) {
        building.inventory.ingot += 1;
        events.push({ type: 'smelted', buildingId: building.id, playerId: building.ownerId });
      }
    } else if (
      canWork &&
      building.kind === 'smelter' &&
      building.inventory.ore > 0 &&
      canStore(building.inventory, building.inventoryCapacity, 'ingot', 1)
    ) {
      building.inventory.ore -= 1;
      building.progress = 3;
    }
    if (state.tick % 100 === 0 && building.health > 0) {
      building.health -= 1;
      events.push({ type: 'hazard', buildingId: building.id });
    }
  }
  for (const link of Object.values(state.logisticsLinks).sort((left, right) =>
    left.id.localeCompare(right.id),
  )) {
    const source = state.buildings[link.sourceBuildingId];
    const target = state.buildings[link.targetBuildingId];
    if (!source || !target) {
      delete state.logisticsLinks[link.id];
      continue;
    }
    if (
      source.constructionTicks > 0 ||
      target.constructionTicks > 0 ||
      source.inventory[link.item] < 1 ||
      !canStore(target.inventory, target.inventoryCapacity, link.item, 1)
    )
      continue;
    source.inventory[link.item] -= 1;
    target.inventory[link.item] += 1;
  }
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
    const target = targets[(state.tick / raider.spawnIntervalTicks) % Math.max(1, targets.length)];
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
  for (const threat of Object.values(state.threats).sort((left, right) =>
    left.id.localeCompare(right.id),
  )) {
    const target = state.buildings[threat.targetBuildingId];
    if (!target || target.health <= 0) {
      delete state.threats[threat.id];
      continue;
    }
    const path = findPath({
      start: threat,
      goal: target,
      maxVisited: 128,
      bounds: {
        minX: Math.min(threat.x, target.x) - 8,
        maxX: Math.max(threat.x, target.x) + 8,
        minY: Math.min(threat.y, target.y) - 8,
        maxY: Math.max(threat.y, target.y) + 8,
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
      threat.x = next.x;
      threat.y = next.y;
    }
    const defense =
      Object.values(state.buildings).filter(
        (building) =>
          building.ownerId === target.ownerId &&
          building.kind === 'watchtower' &&
          building.constructionTicks === 0 &&
          building.health > 0 &&
          manhattanDistance(building, threat) <= raider.watchtowerRange,
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
interface Version10World extends Omit<WorldState, 'schemaVersion' | 'threats'> {
  schemaVersion: 10;
  threats: Record<string, LegacyThreat>;
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
      { ...building, jobPriority: building.kind === 'smelter' ? 1 : 0 },
    ]),
  );
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

/** Forward-only snapshot migration kept inside the platform-independent simulation. */
export const deserializeWorld = (raw: unknown): WorldState => {
  const candidate = structuredClone(raw) as { schemaVersion?: number };
  if (candidate.schemaVersion === 11) return candidate as WorldState;
  if (candidate.schemaVersion === 10) {
    const legacy = candidate as Version10World;
    return {
      ...legacy,
      schemaVersion: 11,
      threats: withThreatPositions(legacy.threats, legacy.buildings),
    } as unknown as WorldState;
  }
  if (candidate.schemaVersion === 9) {
    const legacy = candidate as Version9World;
    return {
      ...legacy,
      schemaVersion: 11,
      players: withLaborFields(legacy.players),
      buildings: withJobPriorities(legacy.buildings),
      threats: withThreatPositions(legacy.threats, legacy.buildings),
    } as unknown as WorldState;
  }
  if (candidate.schemaVersion === 8) {
    const legacy = candidate as Version8World;
    return {
      ...legacy,
      schemaVersion: 11,
      logisticsLinks: {},
      players: withLaborFields(legacy.players),
      buildings: withJobPriorities(legacy.buildings),
      threats: withThreatPositions(legacy.threats, legacy.buildings),
    } as unknown as WorldState;
  }
  if (candidate.schemaVersion === 7) {
    const legacy = candidate as Version7World;
    return {
      ...legacy,
      schemaVersion: 11,
      settlements: individualSettlementsFor(legacy.players),
      logisticsLinks: {},
      players: withLaborFields(legacy.players),
      buildings: withJobPriorities(legacy.buildings),
      threats: withThreatPositions(legacy.threats, legacy.buildings),
    } as unknown as WorldState;
  }
  if (candidate.schemaVersion === 6) {
    const legacy = candidate as Version6World;
    return {
      ...legacy,
      schemaVersion: 11,
      transfers: [],
      settlements: individualSettlementsFor(legacy.players),
      logisticsLinks: {},
      players: withLaborFields(legacy.players),
      buildings: withJobPriorities(legacy.buildings),
      threats: withThreatPositions(legacy.threats, legacy.buildings),
    } as unknown as WorldState;
  }
  if (candidate.schemaVersion === 5) {
    const legacy = candidate as Version5World;
    return {
      ...legacy,
      schemaVersion: 11,
      threats: {},
      transfers: [],
      settlements: individualSettlementsFor(legacy.players),
      logisticsLinks: {},
      players: withLaborFields(legacy.players),
      buildings: withJobPriorities(legacy.buildings),
    } as unknown as WorldState;
  }
  if (candidate.schemaVersion === 4) {
    const legacy = candidate as Version4World;
    return {
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
    } as unknown as WorldState;
  }
  if (candidate.schemaVersion === 3) {
    const legacy = candidate as Version3World;
    return {
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
    } as unknown as WorldState;
  }
  if (candidate.schemaVersion === 2) {
    const legacy = candidate as Version2World;
    return {
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
    } as unknown as WorldState;
  }
  throw new Error(`Unsupported world snapshot schema version: ${String(candidate.schemaVersion)}`);
};

export const snapshot = (state: WorldState): WorldState => structuredClone(state);
export const stateHash = (state: WorldState): string => stableHash(snapshot(state));

/** Read-only invariant inspection for checkpoints, migration verification, and operations. */
export const inspectWorld = (state: WorldState): string[] => {
  const errors: string[] = [];
  const occupied = new Set<string>();
  for (const [id, player] of Object.entries(state.players)) {
    if (player.id !== id) errors.push(`player key ${id} does not match its id`);
    if (
      player.population.total < 0 ||
      player.population.capacity < player.population.total ||
      player.population.employed < 0 ||
      player.population.unemployed < 0 ||
      player.population.employed + player.population.unemployed !== player.population.total
    )
      errors.push(`player ${id} has invalid population`);
    if (
      inventoryTotal(player.inventory) > INVENTORY_CAPACITY ||
      Object.values(player.inventory).some((amount) => amount < 0)
    )
      errors.push(`player ${id} has invalid inventory`);
  }
  for (const [id, building] of Object.entries(state.buildings)) {
    if (building.id !== id) errors.push(`building key ${id} does not match its id`);
    if (!state.players[building.ownerId])
      errors.push(`building ${id} has unknown owner ${building.ownerId}`);
    if (!Number.isSafeInteger(building.x) || !Number.isSafeInteger(building.y))
      errors.push(`building ${id} has invalid coordinates`);
    const position = tileKey(building.x, building.y);
    if (occupied.has(position)) errors.push(`multiple buildings occupy ${position}`);
    else occupied.add(position);
    if (
      building.health < 0 ||
      building.health > building.maxHealth ||
      building.constructionTicks < 0 ||
      !Number.isInteger(building.jobPriority) ||
      building.jobPriority < 0 ||
      building.jobPriority > 3
    )
      errors.push(`building ${id} has invalid health or construction state`);
    if (
      inventoryTotal(building.inventory) > building.inventoryCapacity ||
      Object.values(building.inventory).some((amount) => amount < 0)
    )
      errors.push(`building ${id} has invalid inventory`);
  }
  for (const [id, threat] of Object.entries(state.threats)) {
    if (threat.id !== id) errors.push(`threat key ${id} does not match its id`);
    if (!state.buildings[threat.targetBuildingId])
      errors.push(`threat ${id} has unknown target ${threat.targetBuildingId}`);
    if (threat.health < 1 || threat.damage < 1)
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
    if (!Number.isInteger(transfer.amount) || transfer.amount < 1)
      errors.push(`transfer ${transfer.id} has an invalid amount`);
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
    if (!source || !target || source.kind !== 'storage' || target.kind !== 'smelter')
      errors.push(`logistics link ${id} has invalid endpoints`);
  }
  return errors;
};
