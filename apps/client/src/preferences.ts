export type CameraAction = 'panUp' | 'panLeft' | 'panDown' | 'panRight';

export interface CameraBindings {
  readonly panUp: string;
  readonly panLeft: string;
  readonly panDown: string;
  readonly panRight: string;
}

export interface ClientPreferences {
  readonly textScale: 100 | 120 | 140;
  readonly reducedMotion: boolean;
  readonly camera: CameraBindings;
}

export const PREFERENCE_STORAGE_KEY = 'kings-client-preferences';

export const defaultPreferences: ClientPreferences = {
  textScale: 100,
  reducedMotion: false,
  camera: { panUp: 'KeyW', panLeft: 'KeyA', panDown: 'KeyS', panRight: 'KeyD' },
};

const actions: readonly CameraAction[] = ['panUp', 'panLeft', 'panDown', 'panRight'];
const isTextScale = (value: unknown): value is ClientPreferences['textScale'] =>
  value === 100 || value === 120 || value === 140;
const isBinding = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z][A-Za-z0-9]{1,31}$/.test(value);

export const loadPreferences = (serialized: string | null): ClientPreferences => {
  if (!serialized) return defaultPreferences;
  try {
    const candidate: unknown = JSON.parse(serialized);
    if (!candidate || typeof candidate !== 'object') return defaultPreferences;
    const value = candidate as Partial<ClientPreferences>;
    if (
      !isTextScale(value.textScale) ||
      typeof value.reducedMotion !== 'boolean' ||
      !value.camera ||
      typeof value.camera !== 'object' ||
      !actions.every((action) => isBinding(value.camera?.[action]))
    )
      return defaultPreferences;
    return {
      textScale: value.textScale,
      reducedMotion: value.reducedMotion,
      camera: {
        panUp: value.camera.panUp,
        panLeft: value.camera.panLeft,
        panDown: value.camera.panDown,
        panRight: value.camera.panRight,
      },
    };
  } catch {
    return defaultPreferences;
  }
};

export const withCameraBinding = (
  preferences: ClientPreferences,
  action: CameraAction,
  code: string,
): ClientPreferences | undefined => {
  if (!isBinding(code)) return undefined;
  if (actions.some((other) => other !== action && preferences.camera[other] === code))
    return undefined;
  return { ...preferences, camera: { ...preferences.camera, [action]: code } };
};

export const displayKey = (code: string): string => {
  if (code.startsWith('Key')) return code.slice(3).toUpperCase();
  if (code.startsWith('Digit')) return code.slice(5);
  return code.replace(/^Arrow/, 'Arrow ');
};
