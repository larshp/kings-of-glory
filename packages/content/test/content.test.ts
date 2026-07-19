import { describe, expect, it } from 'vitest';
import {
  logisticsLinks,
  producers,
  resources,
  storage,
  validateContent,
  validateRecipeGraph,
  validateTechnologyGraph,
} from '../src/index.js';

describe('content definitions', () => {
  it('has valid item and recipe references', () => expect(validateContent()).toEqual([]));
  it('declares resource, producer, storage, and logistics schemas for the active production chain', () => {
    expect(resources.ore).toMatchObject({ item: 'ore', yield: 10, renewable: false });
    expect(producers.smelter).toMatchObject({
      buildingId: 'smelter',
      recipeIds: ['smelt-ore'],
      defaultRecipeId: 'smelt-ore',
    });
    expect(producers.workshop.recipeIds).toContain('forge-tool-without-wood');
    expect(storage.storage).toMatchObject({ buildingId: 'storage', capacity: 200 });
    expect(logisticsLinks.internalInventory.throughputPerTick).toBe(1);
  });
  it('rejects cyclic technology prerequisites', () =>
    expect(
      validateTechnologyGraph({
        alpha: { prerequisites: ['beta'] },
        beta: { prerequisites: ['alpha'] },
      }),
    ).toContain('technology graph contains a cycle at alpha'));
  it('rejects cyclic recipe conversions', () =>
    expect(
      validateRecipeGraph({
        makeIngot: { id: 'make-ingot', input: { ore: 1 }, output: { ingot: 1 } },
        reclaimOre: { id: 'reclaim-ore', input: { ingot: 1 }, output: { ore: 1 } },
      }),
    ).toContain('recipe graph contains a cycle at ore'));
});
