import { describe, expect, it } from 'vitest';
import { spriteAtlasManifest, spriteFrames } from './render-assets.js';

describe('render asset manifest', () => {
  it('keeps every sprite inside its declared atlas and on the 64px grid', () => {
    for (const frame of Object.values(spriteFrames)) {
      const atlas = spriteAtlasManifest[frame.atlas];
      expect(frame.x % 64).toBe(0);
      expect(frame.y % 64).toBe(0);
      expect(frame.x + frame.width).toBeLessThanOrEqual(atlas.width);
      expect(frame.y + frame.height).toBeLessThanOrEqual(atlas.height);
      expect(frame.originX).toBe(frame.width / 2);
      expect(frame.originY).toBeGreaterThan(0);
      expect(frame.originY).toBeLessThanOrEqual(frame.height);
    }
  });
});
