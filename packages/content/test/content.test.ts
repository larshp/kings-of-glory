import { describe, expect, it } from 'vitest';
import {
  cooperativeObjectives,
  logisticsLinks,
  onboardingRules,
  producers,
  resources,
  socialRules,
  storage,
  threats,
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
    expect(cooperativeObjectives['frontier-beacon']).toMatchObject({
      contributionItem: 'tool',
      targetAmount: 20,
      reward: { ingot: 2 },
    });
    expect(threats['raider-swarm']).toMatchObject({
      newPlayerProtectionTicks: 300,
      inactiveAfterTicks: 300,
      inactiveHealthFloorPercent: 50,
      maxInactiveThreatsPerPlayer: 1,
      settlementBufferTiles: 2,
    });
    expect(socialRules).toMatchObject({
      playerNameLength: { min: 3, max: 24 },
      chatMessageMaxLength: 280,
      chatCooldownTicks: 5,
      retainedMessages: 500,
    });
    expect(onboardingRules).toEqual({
      abandonedReservationTicks: 36_000,
      securingBuildingKind: 'smelter',
    });
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
