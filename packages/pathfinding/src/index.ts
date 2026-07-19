export interface TileCoordinate { x: number; y: number }
export const manhattanDistance = (from: TileCoordinate, to: TileCoordinate): number => Math.abs(from.x - to.x) + Math.abs(from.y - to.y);
