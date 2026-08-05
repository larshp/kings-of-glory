import {
  buildingUpgrades,
  buildings as buildingDefinitions,
  extractors as extractorDefinitions,
  items as itemDefinitions,
  producers as producerDefinitions,
  recipes,
  renewers as renewerDefinitions,
  type ResourceTerrain,
} from '@kings/content';
import {
  extractionTicksFor,
  recipeTicksFor,
  type Building,
  type ItemKind,
} from '@kings/simulation';

/** Label helpers shared by the HUD panels, kept together so wording stays consistent. */

/** Every carryable item, in the order the HUD lists them. */
export const ITEM_KINDS: readonly ItemKind[] = ['ore', 'wood', 'stone', 'ingot', 'brick', 'tool'];

export const itemLabel = (item: ItemKind) => itemDefinitions[item].displayName;

/** What a player is looking for on the map when an extractor needs a deposit in range. */
export const depositLabel = (terrain: ResourceTerrain) =>
  terrain === 'ore' ? 'ore deposit' : terrain === 'wood' ? 'timber grove' : 'mountain range';

export const technologyCostLabel = (cost: Readonly<Partial<Record<ItemKind, number>>>) =>
  Object.entries(cost)
    .map(([item, amount]) => `${amount} ${item}${amount === 1 ? '' : 's'}`)
    .join(', ');

export const amountLabel = (amounts: object) =>
  Object.entries(amounts as Readonly<Record<string, number>>)
    .map(([item, amount]) => `${amount} ${item}`)
    .join(', ');

export const recipeForBuilding = (building: Building) =>
  Object.values(recipes).find((recipe) => recipe.id === building.recipeId);

export const buildingLabel = (kind: Building['kind']) => buildingDefinitions[kind].displayName;

export const extractorForBuilding = (building: Building) =>
  extractorDefinitions[building.kind as keyof typeof extractorDefinitions];

export const renewerForBuilding = (building: Building) =>
  renewerDefinitions[building.kind as keyof typeof renewerDefinitions];

/** Extractors and recipe producers share the settlement's worker pool and job priorities. */
export const usesWorkers = (building: Building) =>
  Boolean(producerDefinitions[building.kind as keyof typeof producerDefinitions]) ||
  Boolean(extractorForBuilding(building)) ||
  Boolean(renewerForBuilding(building));

export const recipeOptionsForBuilding = (building: Building) => {
  const producer = producerDefinitions[building.kind as keyof typeof producerDefinitions];
  return producer
    ? Object.values(recipes).filter((recipe) =>
        (producer.recipeIds as readonly string[]).includes(recipe.id),
      )
    : [];
};

export const upgradeForBuilding = (building: Pick<Building, 'kind'>) =>
  buildingUpgrades[building.kind as keyof typeof buildingUpgrades];

/** A building's own name, with its tier when it has one, e.g. "Smelter II". */
export const buildingTierLabel = (building: Pick<Building, 'kind' | 'tier'>) =>
  `${buildingDefinitions[building.kind].displayName}${building.tier > 1 ? ' II' : ''}`;

/** What the next tier buys, phrased for the button that spends the materials. */
export const upgradeBenefitLabel = (building: Pick<Building, 'kind' | 'tier'>) => {
  const upgrade = upgradeForBuilding(building);
  if (!upgrade) return '';
  const benefits: string[] = [];
  if (upgrade.workRateMultiplier < 1)
    benefits.push(`${Math.round((1 - upgrade.workRateMultiplier) * 100)}% faster work`);
  if (upgrade.inventoryCapacityMultiplier > 1)
    benefits.push(`${upgrade.inventoryCapacityMultiplier}× storage`);
  if (upgrade.maxHealthMultiplier > 1) benefits.push(`${upgrade.maxHealthMultiplier}× durability`);
  return benefits.join(', ');
};

/** Durations a building actually works at, which its tier scales. */
export const recipeDurationForBuilding = (building: Building) => {
  const recipe = recipeForBuilding(building);
  return recipe ? recipeTicksFor(building, recipe.ticks) : 0;
};
export const extractionDurationForBuilding = (building: Building) => extractionTicksFor(building);
