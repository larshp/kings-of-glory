/** Content schemas deliberately use plain data so the same definitions work in builds and on the server. */
export const CONTENT_VERSION = 1 as const;

export interface ItemDefinition {
  readonly id: string;
  readonly displayName: string;
  readonly stackLimit: number;
}
export interface RecipeDefinition {
  readonly id: string;
  readonly input: Readonly<Record<string, number>>;
  readonly output: Readonly<Record<string, number>>;
  readonly ticks: number;
}
export interface BuildingDefinition {
  readonly id: string;
  readonly displayName: string;
  readonly cost: Readonly<Record<string, number>>;
  readonly inventoryCapacity: number;
  readonly populationCapacity: number;
  readonly maxHealth: number;
  readonly constructionTicks: number;
  readonly requiredTechnology: string | null;
  readonly recipe?: string;
  readonly serviceSatisfaction?: number;
  readonly defenseDamage?: number;
}
export interface TechnologyDefinition {
  readonly id: string;
  readonly displayName: string;
  readonly prerequisites: readonly string[];
  readonly cost: Readonly<Record<string, number>>;
  readonly ticks: number;
}
export interface ResourceNodeDefinition {
  readonly id: string;
  readonly terrain: 'ore' | 'wood';
  readonly item: string;
  readonly yield: number;
  readonly renewable: boolean;
}
export interface ProducerDefinition {
  readonly buildingId: string;
  readonly recipeIds: readonly string[];
  readonly defaultRecipeId: string;
}
export interface StorageDefinition {
  readonly buildingId: string;
  readonly capacity: number;
}
export interface LogisticsLinkDefinition {
  readonly id: string;
  readonly acceptedSourceKinds: readonly string[];
  readonly acceptedTargetKinds: readonly string[];
  readonly throughputPerTick: number;
}
export interface CooperativeObjectiveDefinition {
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
  readonly contributionItem: string;
  readonly targetAmount: number;
  readonly reward: Readonly<Record<string, number>>;
}

export const items = {
  ore: { id: 'ore', displayName: 'Ore', stackLimit: 100 },
  wood: { id: 'wood', displayName: 'Wood', stackLimit: 100 },
  ingot: { id: 'ingot', displayName: 'Ingot', stackLimit: 100 },
  tool: { id: 'tool', displayName: 'Tool', stackLimit: 100 },
} as const satisfies Readonly<Record<string, ItemDefinition>>;

export type ItemId = keyof typeof items;

export const resources = {
  ore: { id: 'ore', terrain: 'ore', item: 'ore', yield: 10, renewable: false },
  wood: { id: 'wood', terrain: 'wood', item: 'wood', yield: 10, renewable: false },
} as const satisfies Readonly<Record<string, ResourceNodeDefinition>>;

export const recipes = {
  smeltOre: { id: 'smelt-ore', input: { ore: 1 }, output: { ingot: 1 }, ticks: 3 },
  forgeTool: {
    id: 'forge-tool',
    input: { ingot: 1, wood: 1 },
    output: { tool: 1 },
    ticks: 5,
  },
  forgeToolWithoutWood: {
    id: 'forge-tool-without-wood',
    input: { ingot: 2 },
    output: { tool: 1 },
    ticks: 4,
  },
} as const satisfies Readonly<Record<string, RecipeDefinition>>;

export const buildings = {
  'settlement-center': {
    id: 'settlement-center',
    displayName: 'Settlement center',
    cost: { wood: 0 },
    inventoryCapacity: 100,
    populationCapacity: 2,
    maxHealth: 25,
    constructionTicks: 0,
    requiredTechnology: null,
  },
  smelter: {
    id: 'smelter',
    displayName: 'Smelter',
    cost: { wood: 3 },
    inventoryCapacity: 20,
    populationCapacity: 0,
    maxHealth: 10,
    constructionTicks: 10,
    requiredTechnology: null,
    recipe: 'smelt-ore',
  },
  workshop: {
    id: 'workshop',
    displayName: 'Workshop',
    cost: { wood: 4 },
    inventoryCapacity: 30,
    populationCapacity: 0,
    maxHealth: 15,
    constructionTicks: 10,
    requiredTechnology: 'metallurgy',
    recipe: 'forge-tool',
  },
  storage: {
    id: 'storage',
    displayName: 'Storage',
    cost: { wood: 2 },
    inventoryCapacity: 200,
    populationCapacity: 0,
    maxHealth: 15,
    constructionTicks: 5,
    requiredTechnology: null,
  },
  housing: {
    id: 'housing',
    displayName: 'Housing',
    cost: { wood: 2 },
    inventoryCapacity: 0,
    populationCapacity: 4,
    maxHealth: 15,
    constructionTicks: 5,
    requiredTechnology: null,
  },
  hearth: {
    id: 'hearth',
    displayName: 'Hearth',
    cost: { wood: 3 },
    inventoryCapacity: 0,
    populationCapacity: 0,
    maxHealth: 15,
    constructionTicks: 5,
    serviceSatisfaction: 20,
    requiredTechnology: null,
  },
  watchtower: {
    id: 'watchtower',
    displayName: 'Watchtower',
    cost: { wood: 2 },
    inventoryCapacity: 0,
    populationCapacity: 0,
    maxHealth: 15,
    constructionTicks: 5,
    defenseDamage: 1,
    requiredTechnology: 'metallurgy',
  },
} as const satisfies Readonly<Record<string, BuildingDefinition>>;

export const producers = {
  smelter: { buildingId: 'smelter', recipeIds: ['smelt-ore'], defaultRecipeId: 'smelt-ore' },
  workshop: {
    buildingId: 'workshop',
    recipeIds: ['forge-tool', 'forge-tool-without-wood'],
    defaultRecipeId: 'forge-tool',
  },
} as const satisfies Readonly<Record<string, ProducerDefinition>>;

export const storage = {
  storage: { buildingId: 'storage', capacity: 200 },
} as const satisfies Readonly<Record<string, StorageDefinition>>;

export const logisticsLinks = {
  internalInventory: {
    id: 'internal-inventory',
    acceptedSourceKinds: ['storage', 'smelter', 'workshop'],
    acceptedTargetKinds: ['smelter', 'workshop'],
    throughputPerTick: 1,
  },
} as const satisfies Readonly<Record<string, LogisticsLinkDefinition>>;

export const technologies = {
  metallurgy: {
    id: 'metallurgy',
    displayName: 'Metallurgy',
    prerequisites: [],
    cost: { ingot: 1 },
    ticks: 10,
  },
  'territorial-charter': {
    id: 'territorial-charter',
    displayName: 'Territorial Charter',
    prerequisites: ['metallurgy'],
    cost: { tool: 2 },
    ticks: 20,
  },
} as const satisfies Readonly<Record<string, TechnologyDefinition>>;

export const threats = {
  'raider-swarm': {
    id: 'raider-swarm',
    spawnIntervalTicks: 150,
    health: 10,
    damage: 2,
    spawnDistance: { min: 6, max: 12 },
    watchtowerRange: 8,
    newPlayerProtectionTicks: 300,
    inactiveAfterTicks: 300,
    inactiveHealthFloorPercent: 50,
    maxInactiveThreatsPerPlayer: 1,
    settlementBufferTiles: 2,
  },
} as const;

export const environmentalEvents = {
  'acid-rain': {
    id: 'acid-rain',
    displayName: 'Acid rain',
    intervalTicks: 100,
    damage: 1,
  },
} as const;

export const cooperativeObjectives = {
  'frontier-beacon': {
    id: 'frontier-beacon',
    displayName: 'Frontier Beacon',
    description: 'Settlements contribute tools to establish a shared warning beacon.',
    contributionItem: 'tool',
    targetAmount: 20,
    reward: { ingot: 2 },
  },
} as const satisfies Readonly<Record<string, CooperativeObjectiveDefinition>>;

export type CooperativeObjectiveId = keyof typeof cooperativeObjectives;

/** Server-enforced social limits; terms are placeholders for a reviewed deployment list. */
export const socialRules = {
  playerNameLength: { min: 3, max: 24 },
  settlementNameLength: { min: 3, max: 32 },
  chatMessageMaxLength: 280,
  reportReasonMaxLength: 200,
  chatCooldownTicks: 5,
  retainedMessages: 500,
  retainedReports: 1_000,
  moderatedTerms: ['admin', 'moderator', 'system'],
} as const;

/**
 * An unfinished starter settlement keeps its reservation only while its owner
 * is active. Completing the first smelter turns that temporary lease into a
 * permanent settlement reservation.
 */
export const onboardingRules = {
  abandonedReservationTicks: 36_000,
  securingBuildingKind: 'smelter',
} as const;

export type TechnologyId = keyof typeof technologies;

export const validateTechnologyGraph = (
  graph: Record<string, { readonly prerequisites: readonly string[] }>,
): string[] => {
  const errors: string[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string) => {
    if (visited.has(id)) return;
    if (visiting.has(id)) {
      errors.push(`technology graph contains a cycle at ${id}`);
      return;
    }
    const technology = graph[id];
    if (!technology) return;
    visiting.add(id);
    for (const prerequisite of technology.prerequisites) visit(prerequisite);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of Object.keys(graph)) visit(id);
  return errors;
};

type RecipeGraphEntry = {
  readonly id: string;
  readonly input: Readonly<Record<string, number>>;
  readonly output: Readonly<Record<string, number>>;
};

/** Rejects conversion loops that would make a content mistake an unbounded source of items. */
export const validateRecipeGraph = (
  graph: Readonly<Record<string, RecipeGraphEntry>>,
): string[] => {
  const errors: string[] = [];
  const edges = new Map<string, Set<string>>();
  for (const recipe of Object.values(graph))
    for (const input of Object.keys(recipe.input))
      for (const output of Object.keys(recipe.output)) {
        const outputs = edges.get(input) ?? new Set<string>();
        outputs.add(output);
        edges.set(input, outputs);
      }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (item: string) => {
    if (visited.has(item)) return;
    if (visiting.has(item)) {
      errors.push(`recipe graph contains a cycle at ${item}`);
      return;
    }
    visiting.add(item);
    for (const output of edges.get(item) ?? []) visit(output);
    visiting.delete(item);
    visited.add(item);
  };
  for (const item of edges.keys()) visit(item);
  return errors;
};

export const validateContent = (): string[] => {
  const errors: string[] = [];
  for (const recipe of Object.values(recipes)) {
    for (const item of [...Object.keys(recipe.input), ...Object.keys(recipe.output)])
      if (!(item in items)) errors.push(`${recipe.id} references unknown item ${item}`);
    if (recipe.ticks < 1) errors.push(`${recipe.id} must take at least one tick`);
  }
  for (const resource of Object.values(resources)) {
    if (!(resource.item in items))
      errors.push(`${resource.id} references unknown item ${resource.item}`);
    if (!Number.isInteger(resource.yield) || resource.yield < 1)
      errors.push(`${resource.id} has an invalid yield`);
  }
  errors.push(...validateRecipeGraph(recipes));
  for (const building of Object.values(buildings)) {
    if (building.inventoryCapacity < 0 || building.populationCapacity < 0)
      errors.push(`${building.id} has an invalid capacity`);
    if (building.maxHealth < 1 || building.constructionTicks < 0)
      errors.push(`${building.id} has invalid construction values`);
  }
  for (const building of Object.values(buildings))
    if (building.requiredTechnology && !(building.requiredTechnology in technologies))
      errors.push(`${building.id} references unknown technology ${building.requiredTechnology}`);
  for (const building of Object.values(buildings))
    if (
      'recipe' in building &&
      !Object.values(recipes).some((recipe) => recipe.id === building.recipe)
    )
      errors.push(`${building.id} references unknown recipe ${building.recipe}`);
  for (const threat of Object.values(threats)) {
    if (
      !Number.isInteger(threat.spawnIntervalTicks) ||
      threat.spawnIntervalTicks < 1 ||
      !Number.isInteger(threat.newPlayerProtectionTicks) ||
      threat.newPlayerProtectionTicks < 0 ||
      !Number.isInteger(threat.inactiveAfterTicks) ||
      threat.inactiveAfterTicks < 1 ||
      !Number.isInteger(threat.inactiveHealthFloorPercent) ||
      threat.inactiveHealthFloorPercent < 1 ||
      threat.inactiveHealthFloorPercent > 100 ||
      !Number.isInteger(threat.maxInactiveThreatsPerPlayer) ||
      threat.maxInactiveThreatsPerPlayer < 1 ||
      !Number.isInteger(threat.settlementBufferTiles) ||
      threat.settlementBufferTiles < 1
    )
      errors.push(`${threat.id} has invalid protection rules`);
  }
  if (
    socialRules.playerNameLength.min < 1 ||
    socialRules.playerNameLength.max < socialRules.playerNameLength.min ||
    socialRules.settlementNameLength.min < 1 ||
    socialRules.settlementNameLength.max < socialRules.settlementNameLength.min ||
    socialRules.chatMessageMaxLength < 1 ||
    socialRules.reportReasonMaxLength < 1 ||
    socialRules.chatCooldownTicks < 1 ||
    socialRules.retainedMessages < 1 ||
    socialRules.retainedReports < 1 ||
    socialRules.moderatedTerms.some((term) => term !== term.toLowerCase() || !term.trim())
  )
    errors.push('social rules are invalid');
  if (
    !Number.isInteger(onboardingRules.abandonedReservationTicks) ||
    onboardingRules.abandonedReservationTicks < 1 ||
    !buildings[onboardingRules.securingBuildingKind]
  )
    errors.push('onboarding rules are invalid');
  for (const producer of Object.values(producers)) {
    if (!buildings[producer.buildingId as keyof typeof buildings])
      errors.push(`producer references unknown building ${producer.buildingId}`);
    if (!(producer.recipeIds as readonly string[]).includes(producer.defaultRecipeId))
      errors.push(`producer ${producer.buildingId} has a default recipe outside its options`);
    for (const recipeId of producer.recipeIds)
      if (!Object.values(recipes).some((recipe) => recipe.id === recipeId))
        errors.push(`producer references unknown recipe ${recipeId}`);
  }
  for (const entry of Object.values(storage)) {
    const building = buildings[entry.buildingId as keyof typeof buildings];
    if (!building) errors.push(`storage references unknown building ${entry.buildingId}`);
    else if (building.inventoryCapacity !== entry.capacity)
      errors.push(`storage ${entry.buildingId} capacity does not match its building`);
  }
  for (const link of Object.values(logisticsLinks)) {
    if (!Number.isInteger(link.throughputPerTick) || link.throughputPerTick < 1)
      errors.push(`logistics link ${link.id} has invalid throughput`);
    for (const kind of [...link.acceptedSourceKinds, ...link.acceptedTargetKinds])
      if (!buildings[kind as keyof typeof buildings])
        errors.push(`logistics link ${link.id} references unknown building ${kind}`);
  }
  for (const technology of Object.values(technologies)) {
    if (technology.ticks < 1) errors.push(`${technology.id} must take at least one tick`);
    for (const [item, amount] of Object.entries(technology.cost)) {
      if (!(item in items)) errors.push(`${technology.id} references unknown item ${item}`);
      if (!Number.isInteger(amount) || amount < 1)
        errors.push(`${technology.id} has an invalid cost for ${item}`);
    }
    for (const prerequisite of technology.prerequisites)
      if (!(prerequisite in technologies))
        errors.push(`${technology.id} references unknown technology ${prerequisite}`);
  }
  errors.push(...validateTechnologyGraph(technologies));
  for (const threat of Object.values(threats)) {
    if (threat.spawnIntervalTicks < 1 || threat.health < 1 || threat.damage < 1)
      errors.push(`${threat.id} has invalid combat values`);
    if (threat.spawnDistance.min < 1 || threat.spawnDistance.max < threat.spawnDistance.min)
      errors.push(`${threat.id} has an invalid spawn distance`);
  }
  for (const event of Object.values(environmentalEvents)) {
    if (event.intervalTicks < 1 || event.damage < 1)
      errors.push(`${event.id} has invalid environmental-event values`);
  }
  for (const objective of Object.values(cooperativeObjectives)) {
    if (!(objective.contributionItem in items))
      errors.push(`${objective.id} references unknown contribution item`);
    if (!Number.isSafeInteger(objective.targetAmount) || objective.targetAmount < 1)
      errors.push(`${objective.id} has an invalid target`);
    for (const [item, amount] of Object.entries(objective.reward)) {
      if (!(item in items)) errors.push(`${objective.id} references unknown reward item ${item}`);
      if (!Number.isSafeInteger(amount) || amount < 1)
        errors.push(`${objective.id} has an invalid reward for ${item}`);
    }
  }
  return errors;
};
