import {
  buildings as buildingDefinitions,
  extractors as extractorDefinitions,
  resources as resourceDefinitions,
  technologies,
  type TechnologyId,
} from '@kings/content';
import type { TerrainTile } from '@kings/protocol';
import type { Building, ItemKind } from '@kings/simulation';
import { amountLabel, depositLabel } from './labels.js';
import type { Tile } from './types.js';

/**
 * The placeable buildings, paired with the command that places each one. The order is part
 * of the interface: it is also the hotkey order, so it must not depend on player state.
 */
export const buildMenuOrder = [
  ['placeSmelter', 'smelter'],
  ['placeMine', 'mine'],
  ['placeLumberCamp', 'lumber-camp'],
  ['placeQuarry', 'quarry'],
  ['placeForester', 'forester'],
  ['placeStorage', 'storage'],
  ['placeHousing', 'housing'],
  ['placeHearth', 'hearth'],
  ['placeWorkshop', 'workshop'],
  ['placeBrickworks', 'brickworks'],
  ['placeWatchtower', 'watchtower'],
  ['placeWall', 'wall'],
] as const satisfies readonly (readonly [string, Building['kind']])[];

/**
 * Digits arm the first ten entries. A hotkey has to mean the same building for a whole
 * game, so the numbering follows the fixed menu order rather than what is unlocked, and
 * the two least frequently placed structures stay click-only rather than renumber the rest.
 */
const hotkeyDigits = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'] as const;

export const placementHotkey = (kind: Building['kind']): string | undefined => {
  const index = buildMenuOrder.findIndex(([, candidate]) => candidate === kind);
  return index < 0 ? undefined : hotkeyDigits[index];
};

export const kindForHotkey = (digit: string): Building['kind'] | undefined => {
  const index = hotkeyDigits.indexOf(digit as (typeof hotkeyDigits)[number]);
  return index < 0 ? undefined : buildMenuOrder[index]?.[1];
};

/**
 * Everything the menu needs to know about the world, passed in so the rules stay pure and
 * the HUD keeps one description of what a site has to satisfy.
 */
export interface PlacementRules {
  readonly unlocked: (technology: TechnologyId) => boolean;
  readonly inventory: Readonly<Record<ItemKind, number>>;
  /** Terrain, territory, protected areas, and occupancy: the checks no kind escapes. */
  readonly isOpenSite: (tile: Tile) => boolean;
  readonly terrainAt: (tile: Tile) => TerrainTile | undefined;
  readonly minedAmount: (tile: Tile) => number;
}

const extractorFor = (kind: Building['kind']) =>
  extractorDefinitions[kind as keyof typeof extractorDefinitions];

/**
 * Mirrors the authoritative extractor rule so an impossible site can be explained before
 * the command is sent. The server stays the judge: it also sees tiles this client cannot.
 */
export const depositInRange = (kind: Building['kind'], tile: Tile, rules: PlacementRules) => {
  const extractor = extractorFor(kind);
  if (!extractor) return true;
  for (let offsetX = -extractor.range; offsetX <= extractor.range; offsetX += 1) {
    const span = extractor.range - Math.abs(offsetX);
    for (let offsetY = -span; offsetY <= span; offsetY += 1) {
      const candidate = { x: tile.x + offsetX, y: tile.y + offsetY };
      if (rules.terrainAt(candidate) !== extractor.terrain) continue;
      if (rules.minedAmount(candidate) < resourceDefinitions[extractor.terrain].yield) return true;
    }
  }
  return false;
};

/** What a building costs the player that cannot be paid yet. */
const missingMaterials = (kind: Building['kind'], rules: PlacementRules) =>
  (Object.entries(buildingDefinitions[kind].cost) as [ItemKind, number][]).filter(
    ([item, amount]) => rules.inventory[item] < amount,
  );

const requiredTechnology = (kind: Building['kind']) =>
  buildingDefinitions[kind].requiredTechnology as TechnologyId | null;

/** A kind-intrinsic note: what the building will do once it stands. */
export const buildingDescription = (kind: Building['kind']) => {
  const extractor = extractorFor(kind);
  return extractor
    ? `Extracts 1 ${extractor.item} every ${extractor.ticksPerUnit} ticks while staffed.`
    : '';
};

export interface BuildMenuEntry {
  readonly commandType: string;
  readonly kind: Building['kind'];
  readonly name: string;
  readonly costLabel: string;
  readonly hotkey: string | undefined;
  readonly description: string;
  /**
   * Why this building cannot be placed anywhere right now. Site-specific problems are
   * deliberately excluded: the player arms a building first and then looks for a site, so
   * the menu only reports research and materials, and the map reports the rest.
   */
  readonly unavailable: string | undefined;
}

export const buildMenuEntries = (rules: PlacementRules): readonly BuildMenuEntry[] =>
  buildMenuOrder.map(([commandType, kind]) => {
    const definition = buildingDefinitions[kind];
    const technology = requiredTechnology(kind);
    const missing = missingMaterials(kind, rules);
    return {
      commandType,
      kind,
      name: definition.displayName,
      costLabel: amountLabel(definition.cost),
      hotkey: placementHotkey(kind),
      description: buildingDescription(kind),
      unavailable:
        technology && !rules.unlocked(technology)
          ? `${technologies[technology].displayName} required.`
          : missing.length > 0
            ? `Needs ${missing
                .map(([item, amount]) => `${amount - rules.inventory[item]} more ${item}`)
                .join(' and ')}.`
            : undefined,
    };
  });

export interface PlacementStatus {
  readonly valid: boolean;
  /** Empty once a site is valid, so the caller can show it whenever it is set. */
  readonly reason: string;
}

/**
 * Whether an armed building can go on one tile, and what to say when it cannot. Ordered
 * from the most fundamental problem to the most specific so a player fixes them in turn.
 */
export const placementStatus = (
  kind: Building['kind'],
  tile: Tile | undefined,
  rules: PlacementRules,
): PlacementStatus => {
  const technology = requiredTechnology(kind);
  if (technology && !rules.unlocked(technology))
    return { valid: false, reason: `${technologies[technology].displayName} required.` };
  const missing = missingMaterials(kind, rules);
  if (missing.length > 0)
    return {
      valid: false,
      reason: `Needs ${missing
        .map(([item, amount]) => `${amount - rules.inventory[item]} more ${item}`)
        .join(' and ')}.`,
    };
  if (!tile) return { valid: false, reason: 'Point at a tile inside your territory.' };
  if (!rules.isOpenSite(tile))
    return { valid: false, reason: 'This tile is claimed, occupied, or not open ground.' };
  const extractor = extractorFor(kind);
  if (extractor && !depositInRange(kind, tile, rules))
    return {
      valid: false,
      reason: `No ${depositLabel(extractor.terrain)} within ${extractor.range} tiles.`,
    };
  return { valid: true, reason: '' };
};
