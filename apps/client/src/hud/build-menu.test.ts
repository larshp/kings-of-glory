import { describe, expect, it } from 'vitest';
import type { TerrainTile } from '@kings/protocol';
import {
  buildMenuEntries,
  kindForHotkey,
  placementHotkey,
  placementStatus,
  type PlacementRules,
} from './build-menu.js';

const rules = (overrides: Partial<PlacementRules> = {}): PlacementRules => ({
  unlocked: () => true,
  inventory: { ore: 10, wood: 10, stone: 10, ingot: 10, brick: 10, tool: 10 },
  isOpenSite: () => true,
  terrainAt: () => 'grass' as TerrainTile,
  minedAmount: () => 0,
  ...overrides,
});

describe('build menu', () => {
  it('states research and material shortfalls without needing a site', () => {
    const entries = buildMenuEntries(
      rules({
        unlocked: (technology) => technology !== 'metallurgy',
        inventory: { ore: 0, wood: 0, stone: 0, ingot: 0, brick: 0, tool: 0 },
      }),
    );
    const workshop = entries.find((entry) => entry.kind === 'workshop');
    expect(workshop?.unavailable).toBe('Metallurgy required.');
    expect(entries.find((entry) => entry.kind === 'smelter')?.unavailable).toBe(
      'Needs 3 more wood.',
    );
    expect(entries.find((entry) => entry.kind === 'mine')?.description).toBe(
      'Extracts 1 ore every 4 ticks while staffed.',
    );
  });

  it('keeps hotkeys stable for the first ten entries in menu order', () => {
    expect(placementHotkey('smelter')).toBe('1');
    expect(placementHotkey('brickworks')).toBe('0');
    expect(placementHotkey('watchtower')).toBeUndefined();
    expect(kindForHotkey('1')).toBe('smelter');
    expect(kindForHotkey('7')).toBe('housing');
    expect(kindForHotkey('x')).toBeUndefined();
  });

  it('reports the most fundamental placement problem first', () => {
    expect(placementStatus('workshop', { x: 1, y: 1 }, rules({ unlocked: () => false }))).toEqual({
      valid: false,
      reason: 'Metallurgy required.',
    });
    expect(
      placementStatus(
        'smelter',
        { x: 1, y: 1 },
        rules({ inventory: { ore: 0, wood: 1, stone: 0, ingot: 0, brick: 0, tool: 0 } }),
      ).reason,
    ).toBe('Needs 2 more wood.');
    expect(placementStatus('smelter', undefined, rules()).reason).toBe(
      'Point at a tile inside your territory.',
    );
    expect(
      placementStatus('smelter', { x: 1, y: 1 }, rules({ isOpenSite: () => false })).reason,
    ).toBe('This tile is claimed, occupied, or not open ground.');
  });

  it('requires an unexhausted deposit in range for extractors only', () => {
    const barren = rules({ terrainAt: () => 'grass' as TerrainTile });
    expect(placementStatus('mine', { x: 4, y: 4 }, barren).reason).toBe(
      'No ore deposit within 4 tiles.',
    );
    expect(placementStatus('storage', { x: 4, y: 4 }, barren)).toEqual({ valid: true, reason: '' });

    const deposit = (x: number, y: number) => x === 6 && y === 4;
    expect(
      placementStatus(
        'mine',
        { x: 4, y: 4 },
        rules({ terrainAt: ({ x, y }) => (deposit(x, y) ? 'ore' : 'grass') }),
      ),
    ).toEqual({ valid: true, reason: '' });
    // An exhausted deposit is no reason to build beside it.
    expect(
      placementStatus(
        'mine',
        { x: 4, y: 4 },
        rules({
          terrainAt: ({ x, y }) => (deposit(x, y) ? 'ore' : 'grass'),
          minedAmount: ({ x, y }) => (deposit(x, y) ? 10 : 0),
        }),
      ).valid,
    ).toBe(false);
  });
});
