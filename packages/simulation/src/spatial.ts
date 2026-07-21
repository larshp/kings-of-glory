import { chunkCoordinate, type ChunkCoordinate } from './commands.js';

export const CHUNK_SIZE = 16;

export interface SpatialEntity {
  readonly id: string;
  readonly x: number;
  readonly y: number;
}

export const chunkCoordinateFor = (x: number, y: number): ChunkCoordinate =>
  chunkCoordinate(Math.floor(x / CHUNK_SIZE), Math.floor(y / CHUNK_SIZE));

export const chunkKey = (chunk: ChunkCoordinate): string => `${chunk[0]}:${chunk[1]}`;

export const chunkKeyFor = (x: number, y: number): string => chunkKey(chunkCoordinateFor(x, y));

/** Cardinal neighbors in a stable clockwise order, useful for chunk-interest expansion. */
export const neighboringChunks = (chunk: ChunkCoordinate): readonly ChunkCoordinate[] => [
  chunkCoordinate(chunk[0], chunk[1] - 1),
  chunkCoordinate(chunk[0] + 1, chunk[1]),
  chunkCoordinate(chunk[0], chunk[1] + 1),
  chunkCoordinate(chunk[0] - 1, chunk[1]),
];

/**
 * Derives a deterministic entity-to-chunk membership index from serializable
 * entity coordinates. The index is intentionally rebuildable, so snapshots do
 * not persist a second, potentially stale source of spatial truth.
 */
export const indexEntitiesByChunk = (
  entities: Iterable<SpatialEntity>,
): Readonly<Record<string, readonly string[]>> => {
  const index: Record<string, string[]> = {};
  for (const entity of entities) {
    const key = chunkKeyFor(entity.x, entity.y);
    (index[key] ??= []).push(entity.id);
  }
  for (const members of Object.values(index))
    members.sort((left, right) => left.localeCompare(right));
  return index;
};
