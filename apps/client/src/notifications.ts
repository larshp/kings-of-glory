export const notificationSeverities = ['critical', 'warning', 'info'] as const;
export type NotificationSeverity = (typeof notificationSeverities)[number];

export const groupNotifications = <T extends { readonly severity: NotificationSeverity }>(
  notifications: readonly T[],
): Array<{ readonly severity: NotificationSeverity; readonly notifications: readonly T[] }> =>
  notificationSeverities
    .map((severity) => ({
      severity,
      notifications: notifications.filter((notification) => notification.severity === severity),
    }))
    .filter((group) => group.notifications.length > 0);

/** One transient message. `count` collapses an immediate repeat instead of stacking copies. */
export interface Notice {
  readonly id: number;
  readonly text: string;
  readonly severity: NotificationSeverity;
  readonly count: number;
}

/** How many toasts may share the screen before the oldest is dropped. */
export const MAX_VISIBLE_NOTICES = 4;
/** How much of the conversation the message log keeps for review. */
export const MESSAGE_LOG_LIMIT = 25;

/**
 * Appends a message to a bounded queue. A burst of acknowledgements used to overwrite the
 * single notice slot, so players lost messages they never saw; the queue keeps them. A
 * repeat of the newest message is counted rather than queued, because gathering ten times
 * should not bury everything else, and the new id restarts that toast's dismiss timer.
 */
export const appendNotice = (
  notices: readonly Notice[],
  message: { readonly text: string; readonly severity: NotificationSeverity },
  id: number,
  limit: number = MAX_VISIBLE_NOTICES,
): readonly Notice[] => {
  const newest = notices[notices.length - 1];
  if (newest?.text === message.text)
    return [...notices.slice(0, -1), { ...newest, id, count: newest.count + 1 }];
  return [...notices, { id, text: message.text, severity: message.severity, count: 1 }].slice(
    -limit,
  );
};
