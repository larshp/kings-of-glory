import {
  buildings as buildingDefinitions,
  extractors as extractorDefinitions,
  producers as producerDefinitions,
  recipes,
  renewers as renewerDefinitions,
} from '@kings/content';
import type { Building } from '@kings/simulation';

/** Label helpers shared by the HUD panels, kept together so wording stays consistent. */

export const technologyCostLabel = (
  cost: Readonly<Partial<Record<'ore' | 'wood' | 'ingot' | 'tool', number>>>,
) =>
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
