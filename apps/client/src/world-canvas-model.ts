import { recipes, resources as resourceDefinitions, terrainRules } from '@kings/content';
import type { TerrainTile } from '@kings/protocol';
import {
  GATHER_RANGE,
  recipeTicksFor,
  type Building,
  type Carrier,
  type LogisticsLink,
  type Threat,
} from '@kings/simulation';
import type { SpriteId } from './render-assets.js';
import { screenToWorld, TILE_HEIGHT, TILE_WIDTH } from './projection.js';

export type OperationsOverlay = 'none' | 'resources' | 'logistics' | 'production' | 'bottlenecks';

export const logisticsStatusColor = (status: LogisticsLink['status']) =>
  status === 'transferred'
    ? '#68d7f5'
    : status === 'in-transit'
      ? '#a88cf0'
      : status === 'target-full' || status === 'source-empty'
        ? '#f4b860'
        : status === 'target-reconfigured' || status === 'constructing' || status === 'no-route'
          ? '#de7780'
          : '#8796a6';

export const productionRateLabel = (building: Pick<Building, 'recipeId' | 'kind' | 'tier'>) => {
  const recipe = Object.values(recipes).find((candidate) => candidate.id === building.recipeId);
  if (!recipe) return 'no recipe';
  const output = Object.entries(recipe.output)
    .map(([item, amount]) => `${amount} ${item}`)
    .join(' + ');
  return `${output}/${recipeTicksFor(building, recipe.ticks)}t`;
};

export interface Viewport {
  readonly panX: number;
  readonly panY: number;
  readonly scale: number;
}

export const cameraOrigin = (width: number, height: number) => ({
  x: width / 2 - TILE_WIDTH / 2,
  y: height / 2 - TILE_HEIGHT / 2,
});

export interface VisibleTileBounds {
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
  readonly center: { x: number; y: number };
}

interface IsometricEntity {
  readonly id: string;
  readonly x: number;
  readonly y: number;
}

export type PickedEntity =
  | { readonly type: 'building'; readonly id: string }
  | { readonly type: 'threat'; readonly id: string };

export const initialCameraFocus = (
  buildings: readonly Building[],
  playerId: string,
  plot: { readonly x: number; readonly y: number; readonly size: number } | undefined,
) => {
  const settlementCenter = buildings.find(
    (building) => building.kind === 'settlement-center' && building.ownerId === playerId,
  );
  if (settlementCenter) return { x: settlementCenter.x, y: settlementCenter.y };
  return plot
    ? { x: plot.x + Math.floor(plot.size / 2), y: plot.y + Math.floor(plot.size / 2) }
    : { x: 0, y: 0 };
};

export const tileHoverLines = ({
  tile,
  terrain,
  elevation,
  minedAmount,
  resourceReachable,
  territoryOwner,
  playerId,
  placementValid,
  building,
  threat,
  carrier,
}: {
  readonly tile: { readonly x: number; readonly y: number };
  readonly terrain: TerrainTile | undefined;
  readonly elevation: number;
  readonly minedAmount: number;
  readonly resourceReachable: boolean;
  readonly territoryOwner: string | undefined;
  readonly playerId: string;
  readonly placementValid: boolean;
  readonly building: Building | undefined;
  readonly threat: Threat | undefined;
  readonly carrier?: Carrier | undefined;
}) => {
  const terrainLabel =
    terrain === 'ore'
      ? 'Ore deposit'
      : terrain === 'wood'
        ? 'Timber grove'
        : terrain === 'water'
          ? 'Water'
          : terrain === 'mountain'
            ? `Mountain · height ${elevation} · quarriable stone`
            : terrain === 'grass'
              ? 'Grassland'
              : 'Unexplored';
  const territoryLabel = territoryOwner
    ? territoryOwner === playerId
      ? 'Your territory'
      : 'Claimed territory'
    : 'Unclaimed territory';
  const lines = [`Tile ${tile.x}, ${tile.y}`, `${terrainLabel} · ${territoryLabel}`];
  if (terrain === 'ore' || terrain === 'wood' || terrain === 'mountain')
    lines.push(
      `${resourceDefinitions[terrain].item} remaining: ${Math.max(0, resourceDefinitions[terrain].yield - minedAmount)}/${resourceDefinitions[terrain].yield}`,
      resourceReachable ? 'Reachable for gathering' : 'Out of gathering range',
    );
  if (building)
    lines.push(
      `${building.kind.replaceAll('-', ' ')}${building.tier > 1 ? ` II` : ''} · ${building.constructionTicks > 0 ? (building.upgradeTier ? 'being upgraded' : 'under construction') : `health ${building.health}/${building.maxHealth}`}`,
    );
  if (threat) lines.push(`Raider threat · health ${threat.health}`);
  if (carrier)
    lines.push(
      `Carrier · ${carrier.cargo} ${carrier.item} ${carrier.phase === 'outbound' ? 'outbound' : 'returning empty'}`,
    );
  lines.push(placementValid ? 'Buildable' : 'Not buildable');
  return lines;
};

export const resourceIsReachable = (
  tile: { readonly x: number; readonly y: number },
  plot: { readonly x: number; readonly y: number; readonly size: number } | undefined,
) =>
  Boolean(
    plot &&
    Math.abs(plot.x + Math.floor(plot.size / 2) - tile.x) +
      Math.abs(plot.y + Math.floor(plot.size / 2) - tile.y) <=
      GATHER_RANGE,
  );

export const entityAtTile = (
  tile: { x: number; y: number },
  buildings: readonly Building[],
  threats: readonly Threat[],
): PickedEntity | undefined => {
  const threat = threats.find((candidate) => candidate.x === tile.x && candidate.y === tile.y);
  if (threat) return { type: 'threat', id: threat.id };
  const building = buildings.find((candidate) => candidate.x === tile.x && candidate.y === tile.y);
  return building ? { type: 'building', id: building.id } : undefined;
};

export const visibleByIsometricDepth = <Entity extends IsometricEntity>(
  entities: readonly Entity[],
  focus: { x: number; y: number },
  radius = 9,
): Entity[] =>
  entities
    .filter(
      (entity) => Math.abs(entity.x - focus.x) <= radius && Math.abs(entity.y - focus.y) <= radius,
    )
    .sort(
      (left, right) =>
        left.x + left.y - (right.x + right.y) ||
        left.y - right.y ||
        left.id.localeCompare(right.id),
    );

export interface IsometricDrawable {
  readonly depth: number;
  readonly y: number;
  /** Ground layer at a shared depth: terrain, resources, buildings, then mobile units. */
  readonly order: number;
}

/**
 * Paints back-to-front while keeping objects on the same projected ground row above
 * raised terrain. Using the row coordinate before the layer made a diagonal mountain
 * tile cover a building whose feet were at exactly the same screen depth.
 */
export const compareIsometricDrawables = (
  left: IsometricDrawable,
  right: IsometricDrawable,
): number => left.depth - right.depth || left.order - right.order || left.y - right.y;

export const visibleTileBounds = (
  width: number,
  height: number,
  focus: { x: number; y: number },
  viewport: Viewport,
): VisibleTileBounds => {
  const origin = cameraOrigin(width, height);
  const screenToAbsoluteWorld = (screenX: number, screenY: number) => {
    const local = screenToWorld({
      x: (screenX - origin.x - viewport.panX) / viewport.scale - TILE_WIDTH / 2,
      y: (screenY - origin.y - viewport.panY) / viewport.scale - TILE_HEIGHT / 2,
    });
    return { x: focus.x + local.x, y: focus.y + local.y };
  };
  const corners = [
    screenToAbsoluteWorld(0, 0),
    screenToAbsoluteWorld(width, 0),
    screenToAbsoluteWorld(0, height),
    screenToAbsoluteWorld(width, height),
  ];
  const xValues = corners.map((corner) => corner.x);
  const yValues = corners.map((corner) => corner.y);
  return {
    minX: Math.floor(Math.min(...xValues)) - 2,
    maxX: Math.ceil(Math.max(...xValues)) + 2,
    minY: Math.floor(Math.min(...yValues)) - 2,
    maxY: Math.ceil(Math.max(...yValues)) + 2,
    center: screenToAbsoluteWorld(width / 2, height / 2),
  };
};

export const visibleChunkCoordinates = (bounds: VisibleTileBounds) => {
  const chunks: Array<{ x: number; y: number }> = [];
  for (let x = Math.floor(bounds.minX / 16); x <= Math.floor(bounds.maxX / 16); x += 1)
    for (let y = Math.floor(bounds.minY / 16); y <= Math.floor(bounds.maxY / 16); y += 1)
      chunks.push({ x, y });
  return chunks;
};

export const visibleRenderChunks = (bounds: VisibleTileBounds) =>
  visibleChunkCoordinates(bounds).map((chunk) => ({
    ...chunk,
    minX: Math.max(bounds.minX, chunk.x * 16),
    maxX: Math.min(bounds.maxX, chunk.x * 16 + 15),
    minY: Math.max(bounds.minY, chunk.y * 16),
    maxY: Math.min(bounds.maxY, chunk.y * 16 + 15),
  }));

export const tileNoise = (x: number, y: number) => {
  let hash = Math.imul(x | 0, 374_761_393) + Math.imul(y | 0, 668_265_263);
  hash = Math.imul(hash ^ (hash >>> 13), 1_274_126_177);
  return (hash ^ (hash >>> 16)) >>> 0;
};

const TILE_PALETTES = {
  grass: ['#3c6e50', '#396949', '#366544', '#33613f', '#315d3d'],
  bank: ['#446049', '#405a45', '#3c5541'],
  water: ['#2a6790', '#276185', '#245b7d'],
  sheen: ['#3d84ae', '#387ea6'],
  rock: ['#5b6472', '#55606c', '#4f5966'],
  grove: ['#2f5c3c', '#2c5738', '#295234'],
  unexplored: ['#20362d', '#1d3129', '#1a2c25'],
  summit: ['#7d8694', '#77808e', '#6f7887', '#69727f', '#828b99'],
  snow: ['#e4ebf2', '#dae2ec', '#cfd9e4'],
  cliffLit: ['#5f6877', '#5a6371'],
  cliffShaded: ['#3f4653', '#3a414d'],
  outcrop: ['#8d96a4', '#616a78'],
  snowFacet: ['#c3ceda', '#eef3f8'],
} as const;

const shadeFrom = (palette: readonly string[], x: number, y: number, salt = 0) =>
  palette[(tileNoise(x, y) + salt) % palette.length]!;

export const tileShade = (terrain: TerrainTile | undefined, x: number, y: number) => {
  const palette =
    terrain === 'water'
      ? TILE_PALETTES.water
      : terrain === 'ore'
        ? TILE_PALETTES.rock
        : terrain === 'wood'
          ? TILE_PALETTES.grove
          : terrain === 'grass'
            ? TILE_PALETTES.grass
            : TILE_PALETTES.unexplored;
  return shadeFrom(palette, x, y);
};

export const MAX_ELEVATION = terrainRules.mountain.maxLevel;

export const summitColors = (x: number, y: number, level: number) => ({
  top:
    level >= MAX_ELEVATION
      ? shadeFrom(TILE_PALETTES.snow, x, y)
      : shadeFrom(TILE_PALETTES.summit, x, y),
  lit: shadeFrom(TILE_PALETTES.cliffLit, x, y),
  shaded: shadeFrom(TILE_PALETTES.cliffShaded, x, y),
  facet:
    tileNoise(x, y) % 3 === 0
      ? shadeFrom(level >= MAX_ELEVATION ? TILE_PALETTES.snowFacet : TILE_PALETTES.outcrop, x, y, 2)
      : undefined,
});

export interface TileLayers {
  readonly base: string;
  readonly patch?: { readonly fill: string; readonly inset: number; readonly sheen?: string };
}

export const tileLayers = (terrain: TerrainTile | undefined, x: number, y: number): TileLayers => {
  if (terrain === 'water')
    return {
      base: shadeFrom(TILE_PALETTES.bank, x, y),
      patch: {
        fill: tileShade(terrain, x, y),
        inset: 5,
        sheen: shadeFrom(TILE_PALETTES.sheen, x, y, 1),
      },
    };
  if (terrain === 'ore' || terrain === 'wood')
    return {
      base: shadeFrom(TILE_PALETTES.grass, x, y),
      patch: { fill: tileShade(terrain, x, y), inset: terrain === 'ore' ? 7 : 6 },
    };
  return { base: tileShade(terrain, x, y) };
};

/**
 * Clutter showing what a deposit has left. Stone shares the mountain tiles it is cut from,
 * so its clutter only appears once a quarry has started working the range: an untouched range
 * should read as terrain, not as a resource pile.
 */
export const resourceDecorationSprite = (
  terrain: TerrainTile | undefined,
  minedAmount: number,
): SpriteId | undefined => {
  if (terrain !== 'ore' && terrain !== 'wood' && terrain !== 'mountain') return undefined;
  if (terrain === 'mountain' && minedAmount === 0) return undefined;
  const total = resourceDefinitions[terrain].yield;
  const remaining = Math.max(0, total - minedAmount);
  const base = terrain === 'ore' ? 'ore-node' : terrain === 'wood' ? 'timber-node' : 'stone-node';
  if (remaining === 0) return `${base}-spent`;
  return remaining * 2 <= total ? `${base}-low` : base;
};

export const borderSides = (
  x: number,
  y: number,
  regionAt: (x: number, y: number) => string | undefined,
): Array<'south-east' | 'south-west' | 'north-west' | 'north-east'> => {
  const region = regionAt(x, y);
  if (!region) return [];
  const sides: Array<'south-east' | 'south-west' | 'north-west' | 'north-east'> = [];
  if (regionAt(x + 1, y) !== region) sides.push('south-east');
  if (regionAt(x, y + 1) !== region) sides.push('south-west');
  if (regionAt(x - 1, y) !== region) sides.push('north-west');
  if (regionAt(x, y - 1) !== region) sides.push('north-east');
  return sides;
};
