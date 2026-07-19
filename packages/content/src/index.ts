export const items = {
  ore: { id: 'ore', displayName: 'Ore', stackLimit: 100 },
  wood: { id: 'wood', displayName: 'Wood', stackLimit: 100 },
  ingot: { id: 'ingot', displayName: 'Ingot', stackLimit: 100 },
  tool: { id: 'tool', displayName: 'Tool', stackLimit: 100 },
} as const;

export type ItemId = keyof typeof items;

export const recipes = {
  smeltOre: { id: 'smelt-ore', input: { ore: 1 }, output: { ingot: 1 }, ticks: 3 },
  forgeTool: {
    id: 'forge-tool',
    input: { ingot: 1, wood: 1 },
    output: { tool: 1 },
    ticks: 5,
  },
} as const;

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
} as const;

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
} as const;

export const threats = {
  'raider-swarm': {
    id: 'raider-swarm',
    spawnIntervalTicks: 150,
    health: 10,
    damage: 2,
    spawnDistance: { min: 6, max: 12 },
    watchtowerRange: 8,
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
  return errors;
};
