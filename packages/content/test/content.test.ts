import { describe, expect, it } from 'vitest';
import { validateContent, validateRecipeGraph, validateTechnologyGraph } from '../src/index.js';

describe('content definitions', () => {
  it('has valid item and recipe references', () => expect(validateContent()).toEqual([]));
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
