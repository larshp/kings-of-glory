export const TILE_WIDTH = 64;
export const TILE_HEIGHT = 32;
export interface Point {
  x: number;
  y: number;
}
export const worldToScreen = (point: Point): Point => ({
  x: ((point.x - point.y) * TILE_WIDTH) / 2,
  y: ((point.x + point.y) * TILE_HEIGHT) / 2,
});
export const screenToWorld = (point: Point): Point => ({
  x: (point.x / (TILE_WIDTH / 2) + point.y / (TILE_HEIGHT / 2)) / 2,
  y: (point.y / (TILE_HEIGHT / 2) - point.x / (TILE_WIDTH / 2)) / 2,
});

/** Converts a pointer position to the nearest rendered diamond tile. */
export const screenToTile = (point: Point): Point => {
  const world = screenToWorld({
    x: point.x - TILE_WIDTH / 2,
    y: point.y - TILE_HEIGHT / 2,
  });
  return { x: Math.round(world.x), y: Math.round(world.y) };
};
