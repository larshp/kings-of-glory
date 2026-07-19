import { describe, expect, it } from 'vitest';
import { screenToWorld, worldToScreen } from './projection.js';
describe('isometric projection', () =>
  it('round trips world positions', () => {
    const source = { x: 7, y: -3 };
    const restored = screenToWorld(worldToScreen(source));
    expect(restored.x).toBeCloseTo(source.x);
    expect(restored.y).toBeCloseTo(source.y);
  }));
