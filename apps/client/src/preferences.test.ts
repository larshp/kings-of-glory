import { describe, expect, it } from 'vitest';
import {
  defaultPreferences,
  displayKey,
  loadPreferences,
  withCameraBinding,
} from './preferences.js';

describe('client preferences', () => {
  it('uses defaults for malformed local preferences', () => {
    expect(loadPreferences('{not json')).toEqual(defaultPreferences);
    expect(loadPreferences(JSON.stringify({ textScale: 150 }))).toEqual(defaultPreferences);
  });

  it('loads validated preferences and prevents duplicate camera bindings', () => {
    const preferences = loadPreferences(
      JSON.stringify({
        textScale: 120,
        reducedMotion: true,
        camera: { panUp: 'KeyI', panLeft: 'KeyJ', panDown: 'KeyK', panRight: 'KeyL' },
      }),
    );
    expect(preferences.textScale).toBe(120);
    expect(withCameraBinding(preferences, 'panUp', 'KeyJ')).toBeUndefined();
    expect(withCameraBinding(preferences, 'panUp', 'ArrowUp')).toMatchObject({
      camera: { panUp: 'ArrowUp' },
    });
    expect(displayKey('ArrowUp')).toBe('Arrow Up');
  });
});
