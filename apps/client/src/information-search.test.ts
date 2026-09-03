import { describe, expect, it } from 'vitest';
import { searchInformation, type InformationEntry } from './information-search.js';

const entries: InformationEntry[] = [
  {
    id: 'smelter',
    category: 'construction',
    title: 'Smelter',
    detail: 'Costs 3 wood and takes 10 worker ticks.',
    keywords: ['industry'],
  },
  {
    id: 'metallurgy',
    category: 'research',
    title: 'Metallurgy',
    detail: 'Costs 1 ingot.',
  },
];

describe('information search', () => {
  it('matches normalized terms across titles, details, and keywords', () => {
    expect(searchInformation(entries, '  INDUSTRY wood ', 'all')).toEqual([entries[0]]);
  });

  it('filters by information category', () => {
    expect(searchInformation(entries, '', 'research')).toEqual([entries[1]]);
  });

  it('requires every query term to match the same entry', () => {
    expect(searchInformation(entries, 'smelter ingot', 'all')).toEqual([]);
  });
});
