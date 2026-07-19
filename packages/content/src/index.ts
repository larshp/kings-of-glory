export const items = {
  ore: { id: 'ore', displayName: 'Ore', stackLimit: 100 },
  wood: { id: 'wood', displayName: 'Wood', stackLimit: 100 },
  ingot: { id: 'ingot', displayName: 'Ingot', stackLimit: 100 },
} as const;

export const recipes = {
  smeltOre: { id: 'smelt-ore', input: { ore: 1 }, output: { ingot: 1 }, ticks: 3 },
} as const;
