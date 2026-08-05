import { describe, expect, it } from 'vitest';
import { appendNotice, groupNotifications, type Notice } from './notifications.js';

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

describe('notice queue', () => {
  const queue = (texts: readonly string[], limit?: number) =>
    texts.reduce<readonly Notice[]>(
      (notices, text, index) => appendNotice(notices, { text, severity: 'info' }, index + 1, limit),
      [],
    );

  it('keeps a burst of different messages instead of overwriting them', () => {
    expect(queue(['first', 'second', 'third']).map((notice) => notice.text)).toEqual([
      'first',
      'second',
      'third',
    ]);
  });

  it('drops the oldest message once the queue is full', () => {
    expect(queue(['a', 'b', 'c', 'd', 'e'], 3).map((notice) => notice.text)).toEqual([
      'c',
      'd',
      'e',
    ]);
  });

  it('counts an immediate repeat and restarts its dismiss timer with a new id', () => {
    const repeated = queue(['Gathered wood.', 'Gathered wood.', 'Gathered wood.']);
    expect(repeated).toHaveLength(1);
    expect(repeated[0]).toMatchObject({ count: 3, id: 3 });
  });

  it('queues a message again once another has followed it', () => {
    expect(queue(['same', 'other', 'same']).map((notice) => notice.text)).toEqual([
      'same',
      'other',
      'same',
    ]);
  });
});
