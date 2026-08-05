import { describe, expect, it } from 'vitest';
import { researchEntries, type ResearchProgress } from './research.js';

const progress = (overrides: Partial<ResearchProgress> = {}): ResearchProgress => ({
  unlocked: {},
  activeTechnology: null,
  ticksRemaining: 0,
  inventory: { ore: 0, wood: 0, stone: 0, ingot: 5, brick: 0, tool: 5 },
  ...overrides,
});

const entry = (list: ReturnType<typeof researchEntries>, id: string) =>
  list.find((candidate) => candidate.id === id)!;

describe('research entries', () => {
  it('orders prerequisites above what they unlock and names both', () => {
    const entries = researchEntries(progress());
    expect(entries[0]?.id).toBe('metallurgy');
    expect(entries.map((candidate) => candidate.depth)).toEqual([0, 1, 1, 1, 1]);
    expect(entry(entries, 'metallurgy').unlocks).toEqual(['workshop', 'watchtower']);
    expect(entry(entries, 'masonry').unlocks).toEqual([
      'quarry',
      'brickworks',
      'wall',
      'building tiers',
    ]);
    expect(entry(entries, 'territorial-charter').prerequisiteNames).toEqual(['Metallurgy']);
    expect(entry(entries, 'engineering').unlocks).toEqual(['roads', 'faster carriers']);
  });

  it('blocks on unmet prerequisites before material cost', () => {
    const entries = researchEntries(progress());
    expect(entry(entries, 'metallurgy').state).toBe('available');
    expect(entry(entries, 'masonry').blockedReason).toBe('Requires Metallurgy.');
    const afterMetallurgy = researchEntries(
      progress({
        unlocked: { metallurgy: true },
        inventory: { ore: 0, wood: 0, stone: 0, ingot: 1, brick: 0, tool: 0 },
      }),
    );
    expect(entry(afterMetallurgy, 'masonry')).toMatchObject({
      blockedBy: 'cost',
      blockedReason: 'Needs 1 more ingot.',
    });
    expect(entry(afterMetallurgy, 'metallurgy').state).toBe('unlocked');
    // A prerequisite and a shortfall are different problems and must not read the same.
    expect(entry(entries, 'masonry').blockedBy).toBe('prerequisites');
  });

  it('reports the technology already being researched', () => {
    const entries = researchEntries(
      progress({ activeTechnology: 'metallurgy', ticksRemaining: 7 }),
    );
    expect(entry(entries, 'metallurgy').state).toBe('researching');
    expect(entry(entries, 'metallurgy').ticksRemaining).toBe(7);
    expect(entry(entries, 'masonry').blockedReason).toBe('Finish researching Metallurgy first.');
  });

  it('announces the permanent path choice and closes the alternative once taken', () => {
    const open = researchEntries(progress({ unlocked: { metallurgy: true } }));
    expect(entry(open, 'engineering').permanentChoice).toBe(
      'Permanent choice: taking this closes Stewardship.',
    );
    expect(entry(open, 'engineering').state).toBe('available');

    const chosen = researchEntries(progress({ unlocked: { metallurgy: true, engineering: true } }));
    expect(entry(chosen, 'stewardship').blockedReason).toBe(
      'Engineering was chosen for this path.',
    );
    expect(entry(chosen, 'stewardship').permanentChoice).toBeUndefined();
    // Masonry is deliberately outside the exclusive group, so it stays open.
    expect(entry(chosen, 'masonry').state).toBe('available');
  });
});
