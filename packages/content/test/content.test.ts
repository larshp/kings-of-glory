import { describe, expect, it } from 'vitest';
import { validateContent, validateTechnologyGraph } from '../src/index.js';

describe('content definitions', () => {
  it('has valid item and recipe references', () => expect(validateContent()).toEqual([]));
  it('rejects cyclic technology prerequisites', () =>
    expect(
      validateTechnologyGraph({
        alpha: { prerequisites: ['beta'] },
        beta: { prerequisites: ['alpha'] },
      }),
    ).toContain('technology graph contains a cycle at alpha'));
});
