export interface TileCoordinate {
  x: number;
  y: number;
}
export const manhattanDistance = (from: TileCoordinate, to: TileCoordinate): number =>
  Math.abs(from.x - to.x) + Math.abs(from.y - to.y);

export interface SearchBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}
export interface PathSearchOptions {
  readonly start: TileCoordinate;
  readonly goal: TileCoordinate;
  readonly isPassable: (tile: TileCoordinate) => boolean;
  /** Hard per-search work budget. Exhaustion is explicit rather than unbounded. */
  readonly maxVisited: number;
  readonly bounds?: SearchBounds;
}
export interface HierarchicalPathSearchOptions extends PathSearchOptions {
  /** Tile width and height of one routing chunk. */
  readonly chunkSize?: number;
  /** Work budget for the coarse chunk-level route, included in `maxVisited`. */
  readonly maxChunkVisited?: number;
  /**
   * Reports whether a chunk can participate in a coarse route. Callers can
   * cheaply invalidate a chunk after terrain, building, or threat changes.
   */
  readonly isChunkPassable?: (chunk: TileCoordinate) => boolean;
}
export type PathSearchResult =
  | { readonly status: 'found'; readonly path: readonly TileCoordinate[]; readonly visited: number }
  | {
      readonly status: 'unreachable' | 'budget-exhausted';
      readonly path: readonly [];
      readonly visited: number;
    };
export type HierarchicalPathSearchResult = PathSearchResult & {
  /** Coarse route in chunk coordinates, including start and goal chunks. */
  readonly chunkPath: readonly TileCoordinate[];
  /** Fine tile-path portions, split at chunk boundaries for local consumers. */
  readonly localPaths: readonly (readonly TileCoordinate[])[];
};

interface FrontierNode {
  readonly tile: TileCoordinate;
  readonly cost: number;
  readonly estimate: number;
}

const keyFor = (tile: TileCoordinate) => `${tile.x}:${tile.y}`;
const compareNodes = (left: FrontierNode, right: FrontierNode) =>
  left.estimate - right.estimate ||
  left.cost - right.cost ||
  left.tile.y - right.tile.y ||
  left.tile.x - right.tile.x;
const inBounds = (tile: TileCoordinate, bounds: SearchBounds | undefined) =>
  !bounds ||
  (tile.x >= bounds.minX &&
    tile.x <= bounds.maxX &&
    tile.y >= bounds.minY &&
    tile.y <= bounds.maxY);
const neighborsOf = (tile: TileCoordinate): readonly TileCoordinate[] => [
  { x: tile.x, y: tile.y - 1 },
  { x: tile.x - 1, y: tile.y },
  { x: tile.x + 1, y: tile.y },
  { x: tile.x, y: tile.y + 1 },
];

/**
 * Deterministic, bounded A* over four-directional tiles. Callers can schedule the returned
 * budget-exhausted result on a later simulation tick instead of allowing pathfinding to stall it.
 */
export const findPath = ({
  start,
  goal,
  isPassable,
  maxVisited,
  bounds,
}: PathSearchOptions): PathSearchResult => {
  if (!Number.isSafeInteger(maxVisited) || maxVisited < 1)
    throw new Error('maxVisited must be a positive safe integer.');
  if (
    !inBounds(start, bounds) ||
    !inBounds(goal, bounds) ||
    !isPassable(start) ||
    !isPassable(goal)
  )
    return { status: 'unreachable', path: [], visited: 0 };
  const startKey = keyFor(start);
  const frontier: FrontierNode[] = [
    { tile: start, cost: 0, estimate: manhattanDistance(start, goal) },
  ];
  const costs = new Map<string, number>([[startKey, 0]]);
  const previous = new Map<string, TileCoordinate>();
  let visited = 0;

  while (frontier.length > 0) {
    frontier.sort(compareNodes);
    const current = frontier.shift()!;
    const currentKey = keyFor(current.tile);
    if (costs.get(currentKey) !== current.cost) continue;
    visited += 1;
    if (current.tile.x === goal.x && current.tile.y === goal.y) {
      const path: TileCoordinate[] = [current.tile];
      let step = previous.get(currentKey);
      while (step) {
        path.push(step);
        step = previous.get(keyFor(step));
      }
      path.reverse();
      return { status: 'found', path, visited };
    }
    if (visited >= maxVisited) return { status: 'budget-exhausted', path: [], visited };
    for (const neighbor of neighborsOf(current.tile)) {
      if (!inBounds(neighbor, bounds) || !isPassable(neighbor)) continue;
      const neighborKey = keyFor(neighbor);
      const nextCost = current.cost + 1;
      const knownCost = costs.get(neighborKey);
      if (knownCost !== undefined && knownCost <= nextCost) continue;
      costs.set(neighborKey, nextCost);
      previous.set(neighborKey, current.tile);
      frontier.push({
        tile: neighbor,
        cost: nextCost,
        estimate: nextCost + manhattanDistance(neighbor, goal),
      });
    }
  }
  return { status: 'unreachable', path: [], visited };
};

export const chunkFor = (tile: TileCoordinate, chunkSize = 16): TileCoordinate => {
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 1)
    throw new Error('chunkSize must be a positive safe integer.');
  return { x: Math.floor(tile.x / chunkSize), y: Math.floor(tile.y / chunkSize) };
};

const chunkBoundsFor = (bounds: SearchBounds | undefined, chunkSize: number) =>
  bounds
    ? {
        minX: Math.floor(bounds.minX / chunkSize),
        maxX: Math.floor(bounds.maxX / chunkSize),
        minY: Math.floor(bounds.minY / chunkSize),
        maxY: Math.floor(bounds.maxY / chunkSize),
      }
    : undefined;
const neighboringChunkKeys = (chunk: TileCoordinate) => [
  keyFor(chunk),
  keyFor({ x: chunk.x, y: chunk.y - 1 }),
  keyFor({ x: chunk.x - 1, y: chunk.y }),
  keyFor({ x: chunk.x + 1, y: chunk.y }),
  keyFor({ x: chunk.x, y: chunk.y + 1 }),
];
const splitLocalPaths = (path: readonly TileCoordinate[], chunkSize: number) => {
  const localPaths: TileCoordinate[][] = [];
  let current: TileCoordinate[] = [];
  let currentChunkKey: string | undefined;
  for (const tile of path) {
    const tileChunkKey = keyFor(chunkFor(tile, chunkSize));
    if (currentChunkKey !== undefined && tileChunkKey !== currentChunkKey) {
      localPaths.push(current);
      current = [];
    }
    current.push(tile);
    currentChunkKey = tileChunkKey;
  }
  if (current.length > 0) localPaths.push(current);
  return localPaths;
};

/**
 * Plans a route in two bounded layers: a coarse chunk A* first, then a local
 * tile A* within that route and its immediate neighboring chunks. The coarse
 * route is explicit so callers can invalidate only affected chunks next tick.
 */
export const findHierarchicalPath = ({
  start,
  goal,
  isPassable,
  maxVisited,
  bounds,
  chunkSize = 16,
  maxChunkVisited = 32,
  isChunkPassable = () => true,
}: HierarchicalPathSearchOptions): HierarchicalPathSearchResult => {
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 1)
    throw new Error('chunkSize must be a positive safe integer.');
  if (!Number.isSafeInteger(maxChunkVisited) || maxChunkVisited < 1)
    throw new Error('maxChunkVisited must be a positive safe integer.');
  const startChunk = chunkFor(start, chunkSize);
  const goalChunk = chunkFor(goal, chunkSize);
  const coarseBounds = chunkBoundsFor(bounds, chunkSize);
  const coarse = findPath({
    start: startChunk,
    goal: goalChunk,
    maxVisited: Math.min(maxVisited, maxChunkVisited),
    ...(coarseBounds ? { bounds: coarseBounds } : {}),
    isPassable: (chunk) =>
      (chunk.x === startChunk.x && chunk.y === startChunk.y) ||
      (chunk.x === goalChunk.x && chunk.y === goalChunk.y) ||
      isChunkPassable(chunk),
  });
  if (coarse.status !== 'found') return { ...coarse, chunkPath: coarse.path, localPaths: [] };
  const remainingBudget = maxVisited - coarse.visited;
  if (remainingBudget < 1)
    return {
      status: 'budget-exhausted',
      path: [],
      visited: coarse.visited,
      chunkPath: coarse.path,
      localPaths: [],
    };
  const corridor = new Set(coarse.path.flatMap(neighboringChunkKeys));
  const local = findPath({
    start,
    goal,
    maxVisited: remainingBudget,
    ...(bounds ? { bounds } : {}),
    isPassable: (tile) => corridor.has(keyFor(chunkFor(tile, chunkSize))) && isPassable(tile),
  });
  return {
    ...local,
    visited: coarse.visited + local.visited,
    chunkPath: coarse.path,
    localPaths: local.status === 'found' ? splitLocalPaths(local.path, chunkSize) : [],
  };
};
