export const items = {
  ore: { id: 'ore', displayName: 'Ore', stackLimit: 100 },
  wood: { id: 'wood', displayName: 'Wood', stackLimit: 100 },
  ingot: { id: 'ingot', displayName: 'Ingot', stackLimit: 100 },
} as const;

export type ItemId = keyof typeof items;

export const recipes = {
  smeltOre: { id: 'smelt-ore', input: { ore: 1 }, output: { ingot: 1 }, ticks: 3 },
} as const;

export const buildings = {
  'settlement-center': {
    id: 'settlement-center',
    displayName: 'Settlement center',
    cost: {},
    inventoryCapacity: 100,
  },
  smelter: {
    id: 'smelter',
    displayName: 'Smelter',
    cost: { wood: 3 },
    inventoryCapacity: 20,
    recipe: 'smelt-ore',
  },
  storage: { id: 'storage', displayName: 'Storage', cost: { wood: 2 }, inventoryCapacity: 200 },
  housing: {
    id: 'housing',
    displayName: 'Housing',
    cost: { wood: 2 },
    inventoryCapacity: 0,
    populationCapacity: 4,
  },
  watchtower: {
    id: 'watchtower',
    displayName: 'Watchtower',
    cost: { wood: 2 },
    inventoryCapacity: 0,
    defenseDamage: 1,
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
    cost: { ingot: 2 },
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

export const validateContent = (): string[] => {
  const errors: string[] = [];
  for (const recipe of Object.values(recipes)) {
    for (const item of [...Object.keys(recipe.input), ...Object.keys(recipe.output)])
      if (!(item in items)) errors.push(`${recipe.id} references unknown item ${item}`);
    if (recipe.ticks < 1) errors.push(`${recipe.id} must take at least one tick`);
  }
  for (const building of Object.values(buildings))
    if (building.inventoryCapacity < 0)
      errors.push(`${building.id} has an invalid inventory capacity`);
  for (const technology of Object.values(technologies)) {
    if (technology.ticks < 1) errors.push(`${technology.id} must take at least one tick`);
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
  return errors;
};
