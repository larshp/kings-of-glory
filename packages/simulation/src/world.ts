import { buildingId, type BuildingId, type Command, type CommandResult, playerId, type PlayerId } from './commands.js';
import { stableHash } from './hash.js';

export interface Inventory { ore: number; wood: number; ingot: number }
export interface Plot { x: number; y: number; size: number }
export interface PlayerState { id: PlayerId; plot: Plot; inventory: Inventory; lastSequence: number }
export interface Building { id: BuildingId; kind: 'settlement-center' | 'smelter'; ownerId: PlayerId; x: number; y: number; health: number; maxHealth: number; progress: number; constructionTicks: number }
export interface WorldState { schemaVersion: 2; seed: number; tick: number; players: Record<string, PlayerState>; buildings: Record<string, Building>; processedCommands: string[]; minedTiles: Record<string, number> }
export interface WorldEvent { type: 'playerJoined' | 'gathered' | 'buildingPlaced' | 'buildingCompleted' | 'buildingCancelled' | 'buildingDemolished' | 'smelted' | 'repaired' | 'hazard'; playerId?: PlayerId; buildingId?: BuildingId }

const INVENTORY_CAPACITY = 100;
const ORE_PER_NODE = 10;
const tileKey = (x: number, y: number) => `${x}:${y}`;
const terrainNoise = (seed: number, x: number, y: number) => Math.abs(Math.imul(seed ^ x, 73856093) ^ Math.imul(y, 19349663)) % 23;
export const terrainAt = (seed: number, x: number, y: number): 'grass' | 'water' | 'ore' => {
  const value = terrainNoise(seed, x, y);
  if (value === 0) return 'water';
  return value % 4 === 0 ? 'ore' : 'grass';
};
const inventoryTotal = (inventory: Inventory) => inventory.ore + inventory.wood + inventory.ingot;

const plotFor = (ordinal: number): Plot => {
  const radius = Math.floor(ordinal / 4) + 1;
  const side = ordinal % 4;
  const positions = [[radius * 12, 0], [0, radius * 12], [-radius * 12, 0], [0, -radius * 12]] as const;
  const [x, y] = positions[side] ?? [0, 0];
  return { x, y, size: 8 };
};

export const createWorld = (seed = 1): WorldState => ({ schemaVersion: 2, seed, tick: 0, players: {}, buildings: {}, processedCommands: [], minedTiles: {} });

export const joinPlayer = (state: WorldState, id: string): WorldEvent[] => {
  if (state.players[id]) return [];
  const typedId = playerId(id);
  const plot = plotFor(Object.keys(state.players).length);
  state.players[id] = { id: typedId, plot, inventory: { ore: 0, wood: 5, ingot: 0 }, lastSequence: 0 };
  const centerId = buildingId(`center-${id}`);
  state.buildings[centerId] = { id: centerId, kind: 'settlement-center', ownerId: typedId, x: plot.x + plot.size - 2, y: plot.y + plot.size - 2, health: 25, maxHealth: 25, progress: 0, constructionTicks: 0 };
  return [{ type: 'playerJoined', playerId: typedId }];
};

const inPlot = (plot: Plot, x: number, y: number) => x >= plot.x && y >= plot.y && x < plot.x + plot.size && y < plot.y + plot.size;
const distance = (a: Plot, x: number, y: number) => Math.abs(a.x + Math.floor(a.size / 2) - x) + Math.abs(a.y + Math.floor(a.size / 2) - y);
export const applyCommand = (state: WorldState, command: Command): { result: CommandResult; events: WorldEvent[] } => {
  const reject = (code: Extract<CommandResult, { accepted: false }>['code']) => ({ result: { accepted: false as const, commandId: command.id, code }, events: [] });
  const player = state.players[command.playerId];
  if (!player) return reject('unknown-player');
  if (state.processedCommands.includes(command.id)) return reject('duplicate-command');
  if (command.sequence <= player.lastSequence) return reject('out-of-order-command');
  const accept = (events: WorldEvent[]) => { player.lastSequence = command.sequence; state.processedCommands.push(command.id); return { result: { accepted: true as const, commandId: command.id }, events }; };
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
  const building = command.type === 'placeSmelter' ? undefined : state.buildings[command.buildingId];
  if (command.type === 'placeSmelter') {
    if (!inPlot(player.plot, command.x, command.y)) return reject('outside-plot');
    if (terrainAt(state.seed, command.x, command.y) === 'water') return reject('tile-not-buildable');
    if (Object.values(state.buildings).some((candidate) => candidate.x === command.x && candidate.y === command.y)) return reject('occupied');
    if (player.inventory.wood < 3) return reject('insufficient-wood');
    const id = buildingId(`smelter-${state.tick}-${Object.keys(state.buildings).length}`);
    player.inventory.wood -= 3;
    state.buildings[id] = { id, kind: 'smelter', ownerId: player.id, x: command.x, y: command.y, health: 10, maxHealth: 10, progress: 0, constructionTicks: 10 };
    return accept([{ type: 'buildingPlaced', playerId: player.id, buildingId: id }]);
  }
  if (!building) return reject('unknown-building');
  if (building.ownerId !== player.id) return reject('not-owner');
  if (building.health <= 0) return reject('building-destroyed');
  if (command.type === 'cancelConstruction') {
    if (building.kind === 'settlement-center') return reject('cannot-demolish');
    if (building.constructionTicks === 0) return reject('construction-incomplete');
    delete state.buildings[building.id];
    player.inventory.wood = Math.min(INVENTORY_CAPACITY, player.inventory.wood + 3);
    return accept([{ type: 'buildingCancelled', playerId: player.id, buildingId: building.id }]);
  }
  if (command.type === 'demolish') {
    if (building.kind === 'settlement-center') return reject('cannot-demolish');
    if (building.constructionTicks > 0) return reject('construction-incomplete');
    delete state.buildings[building.id];
    return accept([{ type: 'buildingDemolished', playerId: player.id, buildingId: building.id }]);
  }
  if (building.constructionTicks > 0) return reject('construction-incomplete');
  if (command.type === 'smelt') {
    if (building.kind !== 'smelter') return reject('wrong-building');
    if (building.progress > 0) return reject('busy');
    if (player.inventory.ore < 1) return reject('insufficient-ore');
    player.inventory.ore -= 1;
    building.progress = 3;
    return accept([]);
  }
  building.health = Math.min(building.maxHealth, building.health + 2);
  return accept([{ type: 'repaired', playerId: player.id, buildingId: building.id }]);
};

export const advanceTick = (state: WorldState): WorldEvent[] => {
  state.tick += 1;
  const events: WorldEvent[] = [];
  for (const building of Object.values(state.buildings)) {
    if (building.constructionTicks > 0) {
      building.constructionTicks -= 1;
      if (building.constructionTicks === 0) events.push({ type: 'buildingCompleted', buildingId: building.id, playerId: building.ownerId });
      continue;
    }
    if (building.progress > 0) {
      building.progress -= 1;
      const owner = state.players[building.ownerId];
      if (building.progress === 0 && owner) { owner.inventory.ingot += 1; events.push({ type: 'smelted', buildingId: building.id, playerId: building.ownerId }); }
    }
    if (state.tick % 100 === 0 && building.health > 0) { building.health -= 1; events.push({ type: 'hazard', buildingId: building.id }); }
  }
  return events;
};

export const snapshot = (state: WorldState): WorldState => structuredClone(state);
export const stateHash = (state: WorldState): string => stableHash(snapshot(state));
