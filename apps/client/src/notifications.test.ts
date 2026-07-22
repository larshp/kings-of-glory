import { describe, expect, it } from 'vitest';
import { groupNotifications } from './notifications.js';

describe('notification grouping', () => {
  it('groups repeated settlement notifications in severity order', () => {
    const grouped = groupNotifications([
      { id: 'jobs', severity: 'info' as const },
      { id: 'raid-a', severity: 'critical' as const },
      { id: 'housing', severity: 'warning' as const },
      { id: 'raid-b', severity: 'critical' as const },
    ]);

    expect(grouped.map(({ severity, notifications }) => [severity, notifications.length])).toEqual([
      ['critical', 2],
      ['warning', 1],
      ['info', 1],
    ]);
  });

  it('omits empty severity groups', () => {
    expect(groupNotifications([{ id: 'jobs', severity: 'info' as const }])).toHaveLength(1);
  });
});
