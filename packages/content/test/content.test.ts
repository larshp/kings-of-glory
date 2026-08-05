import { describe, expect, it } from 'vitest';
import {
  buildings,
  buildingUpgrades,
  cooperativeObjectives,
  extractors,
  logisticsLinks,
  onboardingRules,
  producers,
  recipes,
  renewers,
  resources,
  roadRules,
  socialRules,
  storage,
  technologies,
  threats,
  validateContent,
  validateRecipeGraph,
  validateTechnologyGraph,
} from '../src/index.js';

describe('content definitions', () => {
  it('has valid item and recipe references', () => expect(validateContent()).toEqual([]));
  it('declares resource, producer, storage, and logistics schemas for the active production chain', () => {
    expect(resources.ore).toMatchObject({ item: 'ore', yield: 10, renewable: false });
    expect(resources.wood).toMatchObject({ item: 'wood', yield: 10, renewable: true });
    // Stone is keyed by the terrain it is cut from, so a tile lookup finds its deposit.
    expect(resources.mountain).toMatchObject({
      item: 'stone',
      terrain: 'mountain',
      renewable: false,
    });
    expect(renewers.forester).toMatchObject({
      buildingId: 'forester',
      terrain: 'wood',
      ticksPerUnit: 20,
    });
    expect(extractors.quarry).toMatchObject({
      buildingId: 'quarry',
      terrain: 'mountain',
      item: 'stone',
    });
    expect(roadRules.engineeringTilesPerTick).toBeGreaterThan(roadRules.baseTilesPerTick);
    // Paving must be the cheaper step, or a carrier would be slower on its own road.
    expect(roadRules.roadStepCost).toBeLessThan(roadRules.groundStepCost);
    expect(producers.smelter).toMatchObject({
      buildingId: 'smelter',
      recipeIds: ['smelt-ore'],
      defaultRecipeId: 'smelt-ore',
    });
    expect(producers.workshop.recipeIds).toContain('forge-tool-without-wood');
    expect(producers.brickworks).toMatchObject({
      buildingId: 'brickworks',
      defaultRecipeId: 'fire-brick',
    });
    expect(recipes.fireBrick).toMatchObject({ input: { stone: 2, wood: 1 }, output: { brick: 1 } });
    expect(storage.storage).toMatchObject({ buildingId: 'storage', capacity: 200 });
    expect(logisticsLinks.internalInventory.carrierCapacity).toBe(4);
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
  it('keeps masonry off the permanent development branch so tiers stay reachable', () => {
    expect(technologies.masonry.prerequisites).toEqual(['metallurgy']);
    expect(technologies.masonry).not.toHaveProperty('exclusiveGroup');
    expect(technologies.engineering.exclusiveGroup).toBe('development-path');
  });

  it('gates brick buildings and every building tier behind masonry', () => {
    for (const kind of ['quarry', 'brickworks', 'wall'] as const)
      expect(buildings[kind].requiredTechnology).toBe('masonry');
    expect(buildings.wall.cost).toEqual({ brick: 1 });
    // A wall is the point of the masonry chain: it outlasts every timber building.
    expect(buildings.wall.maxHealth).toBeGreaterThan(buildings.watchtower.maxHealth * 2);
    for (const upgrade of Object.values(buildingUpgrades)) {
      expect(upgrade.requiredTechnology).toBe('masonry');
      expect(upgrade.cost).toHaveProperty('brick');
    }
    // Storage gains room rather than speed, so its tier is the one exception.
    expect(buildingUpgrades.storage.inventoryCapacityMultiplier).toBeGreaterThan(1);
    expect(buildingUpgrades.smelter.workRateMultiplier).toBeLessThan(1);
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
