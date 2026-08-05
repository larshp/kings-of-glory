import { terrainRules } from '@kings/content';

const RESOURCE_SECTOR_SIZE = 8;

const coordinateNoise = (seed: number, x: number, y: number) =>
  Math.abs(Math.imul(seed ^ x, 73856093) ^ Math.imul(y, 19349663));
const terrainNoise = (seed: number, x: number, y: number) => coordinateNoise(seed, x, y) % 23;
const resourceNodeAt = (seed: number, x: number, y: number): 'ore' | 'wood' | undefined => {
  const sectorX = Math.floor(x / RESOURCE_SECTOR_SIZE);
  const sectorY = Math.floor(y / RESOURCE_SECTOR_SIZE);
  const oreX = coordinateNoise(seed ^ 0x4f1bbcdd, sectorX, sectorY) % RESOURCE_SECTOR_SIZE;
  const oreY = coordinateNoise(seed ^ 0x19a4e6d3, sectorX, sectorY) % RESOURCE_SECTOR_SIZE;
  let woodX = coordinateNoise(seed ^ 0x74e1a2b9, sectorX, sectorY) % RESOURCE_SECTOR_SIZE;
  const woodY = coordinateNoise(seed ^ 0x2b6d9c41, sectorX, sectorY) % RESOURCE_SECTOR_SIZE;
  if (woodX === oreX && woodY === oreY) woodX = (woodX + 1) % RESOURCE_SECTOR_SIZE;
  const localX = x - sectorX * RESOURCE_SECTOR_SIZE;
  const localY = y - sectorY * RESOURCE_SECTOR_SIZE;
  if (localX === oreX && localY === oreY) return 'ore';
  if (localX === woodX && localY === woodY) return 'wood';
  return undefined;
};

/** One lattice corner's unit gradient dotted with the sample offset. */
const gradientDot = (
  seed: number,
  cellX: number,
  cellY: number,
  deltaX: number,
  deltaY: number,
) => {
  let hash = Math.imul(cellX, 0x27d4eb2d) ^ Math.imul(cellY, 0x165667b1) ^ seed;
  hash = Math.imul(hash ^ (hash >>> 15), 0x2c1b3c6d);
  hash = Math.imul(hash ^ (hash >>> 12), 0x297a2d39);
  hash ^= hash >>> 15;
  const angle = (hash >>> 0) * ((Math.PI * 2) / 4294967296);
  return Math.cos(angle) * deltaX + Math.sin(angle) * deltaY;
};

const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);

const perlin = (seed: number, x: number, y: number) => {
  const cellX = Math.floor(x);
  const cellY = Math.floor(y);
  const corner = (offsetX: number, offsetY: number) =>
    gradientDot(seed, cellX + offsetX, cellY + offsetY, x - cellX - offsetX, y - cellY - offsetY);
  const easeX = fade(x - cellX);
  const easeY = fade(y - cellY);
  const north = corner(0, 0) + easeX * (corner(1, 0) - corner(0, 0));
  const south = corner(0, 1) + easeX * (corner(1, 1) - corner(0, 1));
  return (north + easeY * (south - north)) * Math.SQRT2;
};

const ridgeStrength = (seed: number, x: number, y: number) => {
  const { ridgeScale, octaves } = terrainRules.mountain;
  let frequency = 1 / ridgeScale;
  let amplitude = 1;
  let total = 0;
  let maximum = 0;
  for (let octave = 0; octave < octaves; octave += 1) {
    const ridge =
      1 - Math.abs(perlin(seed ^ Math.imul(octave + 1, 0x9e3779b9), x * frequency, y * frequency));
    total += ridge * ridge * amplitude;
    maximum += amplitude;
    frequency *= 2;
    amplitude *= 0.5;
  }
  return total / maximum;
};

/** Deterministic tile elevation. Only mountains rise above level zero. */
export const elevationAt = (seed: number, x: number, y: number): number => {
  if (resourceNodeAt(seed, x, y) || terrainNoise(seed, x, y) === 0) return 0;
  const { threshold, maxLevel } = terrainRules.mountain;
  const strength = ridgeStrength(seed, x, y);
  if (strength < threshold) return 0;
  const climb = (strength - threshold) / (1 - threshold);
  return Math.max(1, Math.min(maxLevel, Math.ceil(climb * maxLevel)));
};

export const terrainAt = (
  seed: number,
  x: number,
  y: number,
): 'grass' | 'water' | 'ore' | 'wood' | 'mountain' => {
  const resource = resourceNodeAt(seed, x, y);
  if (resource) return resource;
  if (terrainNoise(seed, x, y) === 0) return 'water';
  return elevationAt(seed, x, y) > 0 ? 'mountain' : 'grass';
};

export const isOpenTile = (seed: number, x: number, y: number) => {
  const terrain = terrainAt(seed, x, y);
  return terrain !== 'water' && terrain !== 'mountain';
};

export const nearestOreTile = (seed: number, x: number, y: number, range: number) =>
  nearestResourceTile(seed, x, y, range, 'ore');

export const nearestResourceTile = (
  seed: number,
  x: number,
  y: number,
  range: number,
  resource: 'ore' | 'wood',
) => {
  for (let distance = 0; distance <= range; distance += 1)
    for (let offsetX = -distance; offsetX <= distance; offsetX += 1) {
      const offsetY = distance - Math.abs(offsetX);
      const candidates = offsetY === 0 ? [y] : [y - offsetY, y + offsetY];
      for (const candidateY of candidates) {
        const candidateX = x + offsetX;
        if (terrainAt(seed, candidateX, candidateY) === resource)
          return { x: candidateX, y: candidateY };
      }
    }
  return undefined;
};
