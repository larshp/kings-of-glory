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

/**
 * Screen pixels a tile rises per elevation level. One level is a whole tile block rather
 * than a shallow ledge: in this 2:1 projection a cube's vertical edge is half the tile
 * width, so a raised tile is as tall as the tile it stands on and a summit several levels
 * up reads as a mountain instead of a plateau. Ranges do tower over nearby buildings,
 * which is the intent — height is what separates a mountain from rough ground.
 */
export const ELEVATION_STEP = TILE_WIDTH / 2;

/** Converts a pointer position to the nearest rendered diamond tile on flat ground. */
export const screenToTile = (point: Point): Point => {
  const world = screenToWorld({
    x: point.x - TILE_WIDTH / 2,
    y: point.y - TILE_HEIGHT / 2,
  });
  return { x: Math.round(world.x), y: Math.round(world.y) };
};

/**
 * Converts a pointer position to the topmost tile surface under it. A tile at level L is
 * drawn L steps higher than flat ground, so the tile whose top face covers a point is the
 * flat tile that many steps below it. Testing from the tallest level down therefore
 * returns the surface a player sees, and falls back to flat ground when nothing is raised.
 *
 * Cliff faces are deliberately not pickable: they belong to a tile whose top is elsewhere,
 * and raised tiles are mountains, which accept no commands.
 */
export const screenToRaisedTile = (
  point: Point,
  levelAt: (x: number, y: number) => number,
  maxLevel: number,
): Point => {
  for (let level = maxLevel; level > 0; level -= 1) {
    const candidate = screenToTile({ x: point.x, y: point.y + level * ELEVATION_STEP });
    if (levelAt(candidate.x, candidate.y) === level) return candidate;
  }
  return screenToTile(point);
};
