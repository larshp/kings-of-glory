import { chunkKeyFor } from './spatial.js';
import type { Building, PlayerState, Scout, Threat, WorldState } from './world.js';

/**
 * A serializable summary of state that changed between two completed simulation
 * operations. It deliberately contains identifiers rather than entity copies:
 * callers can use it to build deltas or dirty-chunk persistence writes without
 * creating a second authoritative entity store.
 */
export interface WorldChangeSet {
  readonly players: readonly string[];
  readonly buildings: readonly string[];
  readonly threats: readonly string[];
  readonly scouts: readonly string[];
  readonly settlements: readonly string[];
  readonly logisticsLinks: readonly string[];
  readonly minedTiles: readonly string[];
  /** Includes both the old and new chunk when an entity changes chunk or is removed. */
  readonly chunks: readonly string[];
  /** Tick, PRNG, or other world-level state changed outside an entity registry. */
  readonly world: boolean;
}

const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const changedKeys = <T>(previous: Readonly<Record<string, T>>, next: Readonly<Record<string, T>>) =>
  [...new Set([...Object.keys(previous), ...Object.keys(next)])]
    .filter((key) => !same(previous[key], next[key]))
    .sort((left, right) => left.localeCompare(right));

const entityChunks = <T extends { x: number; y: number }>(
  previous: Readonly<Record<string, T>>,
  next: Readonly<Record<string, T>>,
  ids: readonly string[],
) => {
  const chunks = new Set<string>();
  for (const id of ids) {
    const before = previous[id];
    const after = next[id];
    if (before) chunks.add(chunkKeyFor(before.x, before.y));
    if (after) chunks.add(chunkKeyFor(after.x, after.y));
  }
  return chunks;
};

const changedPlayerChunks = (
  previous: Readonly<Record<string, PlayerState>>,
  next: Readonly<Record<string, PlayerState>>,
  ids: readonly string[],
) => {
  const chunks = new Set<string>();
  for (const id of ids) {
    const before = previous[id];
    const after = next[id];
    if (before) {
      chunks.add(chunkKeyFor(before.plot.x, before.plot.y));
      for (const chunk of Object.keys(before.exploredChunks)) chunks.add(chunk);
      for (const chunk of Object.keys(before.visibleChunks ?? {})) chunks.add(chunk);
    }
    if (after) {
      chunks.add(chunkKeyFor(after.plot.x, after.plot.y));
      for (const chunk of Object.keys(after.exploredChunks)) chunks.add(chunk);
      for (const chunk of Object.keys(after.visibleChunks ?? {})) chunks.add(chunk);
    }
  }
  return chunks;
};

const minedTileChunks = (tiles: readonly string[]) => {
  const chunks = new Set<string>();
  for (const tile of tiles) {
    const [xText, yText] = tile.split(':');
    const x = Number(xText);
    const y = Number(yText);
    if (Number.isSafeInteger(x) && Number.isSafeInteger(y)) chunks.add(chunkKeyFor(x, y));
  }
  return chunks;
};

/**
 * Returns the deterministic dirty set from two snapshots. Call this after an
 * accepted command or tick; rejected commands leave it empty. Deleted entities
 * remain represented by their id and previous chunk.
 */
export const diffWorld = (previous: WorldState, next: WorldState): WorldChangeSet => {
  const players = changedKeys(previous.players, next.players);
  const buildings = changedKeys(previous.buildings, next.buildings);
  const threats = changedKeys(previous.threats, next.threats);
  const scouts = changedKeys(previous.scouts ?? {}, next.scouts ?? {});
  const settlements = changedKeys(previous.settlements, next.settlements);
  const logisticsLinks = changedKeys(previous.logisticsLinks, next.logisticsLinks);
  const minedTiles = changedKeys(previous.minedTiles, next.minedTiles);
  const chunks = new Set<string>([
    ...entityChunks<Building>(previous.buildings, next.buildings, buildings),
    ...entityChunks<Threat>(previous.threats, next.threats, threats),
    ...entityChunks<Scout>(previous.scouts ?? {}, next.scouts ?? {}, scouts),
    ...changedPlayerChunks(previous.players, next.players, players),
    ...minedTileChunks(minedTiles),
  ]);
  return {
    players,
    buildings,
    threats,
    scouts,
    settlements,
    logisticsLinks,
    minedTiles,
    chunks: [...chunks].sort((left, right) => left.localeCompare(right)),
    world:
      previous.tick !== next.tick ||
      previous.randomState !== next.randomState ||
      previous.seed !== next.seed ||
      previous.schemaVersion !== next.schemaVersion ||
      !same(previous.processedCommands, next.processedCommands) ||
      !same(previous.transfers, next.transfers),
  };
};
