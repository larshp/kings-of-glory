export const informationCategories = [
  'construction',
  'recipes',
  'inventory',
  'population',
  'research',
  'defense',
  'alerts',
] as const;

export type InformationCategory = (typeof informationCategories)[number];

export interface InformationEntry {
  readonly id: string;
  readonly category: InformationCategory;
  readonly title: string;
  readonly detail: string;
  readonly keywords?: readonly string[];
}

const fold = (value: string) => value.normalize('NFKC').toLocaleLowerCase('en-US');

export const searchInformation = (
  entries: readonly InformationEntry[],
  query: string,
  category: InformationCategory | 'all',
): InformationEntry[] => {
  const terms = fold(query).trim().split(/\s+/u).filter(Boolean);
  return entries.filter((entry) => {
    if (category !== 'all' && entry.category !== category) return false;
    const haystack = fold(
      [entry.category, entry.title, entry.detail, ...(entry.keywords ?? [])].join(' '),
    );
    return terms.every((term) => haystack.includes(term));
  });
};
