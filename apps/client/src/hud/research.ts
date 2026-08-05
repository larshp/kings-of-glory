import {
  buildings as buildingDefinitions,
  buildingUpgrades,
  technologies,
  type TechnologyDefinition,
  type TechnologyId,
} from '@kings/content';
import type { ItemKind } from '@kings/simulation';

/**
 * The research interface is generated from the content graph rather than written out per
 * technology, so a new technology, cost, or prerequisite appears in the HUD as soon as it
 * exists in content and the two can never disagree about what is available.
 */

const definitions: Readonly<Record<TechnologyId, TechnologyDefinition>> = technologies;

const technologyIds = Object.keys(definitions) as readonly TechnologyId[];

/** Longest prerequisite chain behind a technology, which is also its row in the tree. */
const depthOf = (id: TechnologyId): number => {
  const prerequisites = definitions[id].prerequisites as readonly TechnologyId[];
  return prerequisites.length === 0 ? 0 : 1 + Math.max(...prerequisites.map(depthOf));
};

/** The other permanent choices that taking this technology would close for good. */
const exclusiveAlternatives = (id: TechnologyId): readonly TechnologyId[] => {
  const group = definitions[id].exclusiveGroup;
  return group
    ? technologyIds.filter(
        (candidate) => candidate !== id && definitions[candidate].exclusiveGroup === group,
      )
    : [];
};

/**
 * Abilities the world rules gate on research directly instead of through a content
 * definition, so they cannot be derived from the tables below.
 */
const ruleUnlocks: Partial<Record<TechnologyId, readonly string[]>> = {
  engineering: ['roads', 'faster carriers'],
  'territorial-charter': ['claiming explored sectors'],
};

const unlocksFor = (id: TechnologyId): readonly string[] => [
  ...Object.values(buildingDefinitions)
    .filter((building) => building.requiredTechnology === id)
    .map((building) => building.displayName.toLowerCase()),
  ...(Object.values(buildingUpgrades).some((upgrade) => upgrade.requiredTechnology === id)
    ? ['building tiers']
    : []),
  ...(ruleUnlocks[id] ?? []),
];

export type ResearchState = 'unlocked' | 'researching' | 'available' | 'blocked';

/** What stands in the way, which is not the same thing as how it is worded. */
export type ResearchBlocker = 'research-in-progress' | 'path-closed' | 'prerequisites' | 'cost';

export interface ResearchEntry {
  readonly id: TechnologyId;
  readonly name: string;
  readonly costLabel: string;
  readonly ticks: number;
  readonly depth: number;
  readonly prerequisiteNames: readonly string[];
  readonly unlocks: readonly string[];
  readonly state: ResearchState;
  /** Only set while this technology is the one being researched. */
  readonly ticksRemaining: number | undefined;
  /** Set while the choice is still open, so a one-way decision says so before it is made. */
  readonly permanentChoice: string | undefined;
  /** What blocks it, so the badge can distinguish "locked" from "cannot afford it yet". */
  readonly blockedBy: ResearchBlocker | undefined;
  /** Why the button is disabled, in the same order the server rejects the command. */
  readonly blockedReason: string | undefined;
}

export interface ResearchProgress {
  readonly unlocked: Readonly<Partial<Record<TechnologyId, boolean>>>;
  readonly activeTechnology: string | null;
  readonly ticksRemaining: number;
  readonly inventory: Readonly<Record<ItemKind, number>>;
}

const costLabel = (cost: Readonly<Record<string, number>>) =>
  Object.entries(cost)
    .map(([item, amount]) => `${amount} ${item}${amount === 1 ? '' : 's'}`)
    .join(', ');

const shortfall = (
  cost: Readonly<Record<string, number>>,
  inventory: ResearchProgress['inventory'],
) =>
  Object.entries(cost)
    .filter(([item, amount]) => inventory[item as ItemKind] < amount)
    .map(([item, amount]) => `${amount - inventory[item as ItemKind]} more ${item}`);

/** Reported in the order the server rejects the command, so the first fix is the real one. */
const blocker = (
  id: TechnologyId,
  progress: ResearchProgress,
): { readonly by: ResearchBlocker; readonly reason: string } | undefined => {
  const definition = definitions[id];
  if (progress.activeTechnology)
    return {
      by: 'research-in-progress',
      reason: `Finish researching ${definitions[progress.activeTechnology as TechnologyId].displayName} first.`,
    };
  const taken = exclusiveAlternatives(id).find((candidate) => progress.unlocked[candidate]);
  if (taken)
    return {
      by: 'path-closed',
      reason: `${definitions[taken].displayName} was chosen for this path.`,
    };
  const missing = (definition.prerequisites as readonly TechnologyId[]).filter(
    (prerequisite) => !progress.unlocked[prerequisite],
  );
  if (missing.length > 0)
    return {
      by: 'prerequisites',
      reason: `Requires ${missing.map((prerequisite) => definitions[prerequisite].displayName).join(' and ')}.`,
    };
  const missingItems = shortfall(definition.cost, progress.inventory);
  return missingItems.length > 0
    ? { by: 'cost', reason: `Needs ${missingItems.join(' and ')}.` }
    : undefined;
};

/** Every technology, ordered so prerequisites always appear above what they unlock. */
export const researchEntries = (progress: ResearchProgress): readonly ResearchEntry[] =>
  technologyIds
    .map((id) => {
      const definition = definitions[id];
      const alternatives = exclusiveAlternatives(id);
      const unlocked = Boolean(progress.unlocked[id]);
      const researching = progress.activeTechnology === id;
      const blocked = unlocked || researching ? undefined : blocker(id, progress);
      return {
        id,
        name: definition.displayName,
        costLabel: costLabel(definition.cost),
        ticks: definition.ticks,
        depth: depthOf(id),
        prerequisiteNames: (definition.prerequisites as readonly TechnologyId[]).map(
          (prerequisite) => definitions[prerequisite].displayName,
        ),
        unlocks: unlocksFor(id),
        state: unlocked
          ? ('unlocked' as const)
          : researching
            ? ('researching' as const)
            : blocked
              ? ('blocked' as const)
              : ('available' as const),
        ticksRemaining: researching ? progress.ticksRemaining : undefined,
        permanentChoice:
          alternatives.length > 0 && !alternatives.some((candidate) => progress.unlocked[candidate])
            ? `Permanent choice: taking this closes ${alternatives
                .map((candidate) => definitions[candidate].displayName)
                .join(' and ')}.`
            : undefined,
        blockedBy: blocked?.by,
        blockedReason: blocked?.reason,
      };
    })
    .sort((left, right) => left.depth - right.depth || left.name.localeCompare(right.name));
