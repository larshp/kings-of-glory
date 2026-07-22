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
