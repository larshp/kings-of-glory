/**
 * How the client reaches the game server, and the two pieces of player-facing status that
 * exist outside React: the rejection copy for a refused command, and the startup indicator
 * in `index.html` that reports progress before the app has mounted.
 */
const defaultServerHost = import.meta.env.DEV
  ? 'localhost'
  : window.location.hostname || 'localhost';
const defaultServerUrl = `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${defaultServerHost}:3001`;
export const serverUrl = import.meta.env.VITE_SERVER_URL ?? defaultServerUrl;
const sessionUrl = new URL(serverUrl);
sessionUrl.protocol = sessionUrl.protocol === 'wss:' ? 'https:' : 'http:';
sessionUrl.pathname = '/session';
sessionUrl.search = '';
sessionUrl.hash = '';
const storedPlayerId = sessionStorage.getItem('kings-dev-player-id');
export const fallbackPlayerId = storedPlayerId ?? `dev-${crypto.randomUUID().slice(0, 8)}`;
export const playerIdPromise = (async () => {
  let resolvedPlayerId = fallbackPlayerId;
  try {
    const response = await fetch(sessionUrl, { method: 'POST', credentials: 'include' });
    if (response.ok) {
      const session = (await response.json()) as { playerId?: unknown };
      if (typeof session.playerId === 'string') resolvedPlayerId = session.playerId;
    }
  } catch {
    // Development remains usable while the local server starts; production WebSockets require a session.
  }
  sessionStorage.setItem('kings-dev-player-id', resolvedPlayerId);
  return resolvedPlayerId;
})();

export const rejectionMessage = (code: string | undefined) => {
  const messages: Record<string, string> = {
    'invalid-coordinate': 'That map coordinate is invalid.',
    'out-of-range': 'That tile is too far from your settlement.',
    'resource-depleted': 'That deposit is exhausted. Try another resource tile.',
    'no-deposit-in-range':
      'Build extractors beside a deposit that still has yield: mines need ore, lumber camps need timber.',
    'outside-plot': 'Build inside your claimed territory.',
    'protected-area': 'That area preserves another settlement or its access route.',
    'reserved-resource': 'That resource is reserved for the nearest starting settlement.',
    occupied: 'Another building already occupies that tile.',
    'insufficient-wood': 'Gather more wood before starting this construction.',
    'insufficient-ore': 'Gather or transfer more ore first.',
    'insufficient-resources': 'Gather, craft, or transfer the required resources first.',
    'inventory-full': 'Move or use items to make inventory space.',
    'construction-incomplete': 'Wait for construction to finish before using this building.',
    busy: 'Wait for the current production batch to finish before changing its recipe.',
    'invalid-recipe': 'That recipe cannot run in this building.',
    'incompatible-building': 'Copy settings only between completed producers of the same kind.',
    'building-destroyed': 'Repair or demolish the destroyed building first.',
    'technology-locked': 'Research the required technology first.',
    'research-branch-locked': 'That development path is locked by your earlier research choice.',
    'road-exists': 'A road already occupies that tile.',
    'unknown-objective': 'That cooperative objective is no longer available.',
    'objective-complete': 'That cooperative objective is already complete.',
    'objective-incomplete': 'The objective must be completed before rewards can be claimed.',
    'objective-contribution-required': 'Contribute before claiming this objective reward.',
    'reward-already-claimed': 'You already claimed this objective reward.',
    'unknown-project': 'That shared construction project no longer exists.',
    'project-complete': 'That shared construction project is already fully funded.',
    'project-limit-reached': 'Complete an active settlement project before starting another.',
    'construction-limit-reached':
      'Complete or cancel an active construction before starting another.',
    'invalid-name':
      'Use the allowed length and only letters, numbers, spaces, periods, apostrophes, or hyphens.',
    'name-taken': 'That name is already in use.',
    'content-rejected': 'That text was rejected by the world moderation rules.',
    'chat-rate-limited': 'Wait a few world ticks before sending another message.',
    'invalid-message': 'Enter a non-empty message within the length limit.',
    'unknown-message': 'That chat message is no longer available.',
    'already-reported': 'You already reported that message.',
    'cannot-block-self': 'You cannot block yourself.',
    'not-explored': 'Explore that area before claiming it.',
    'not-adjacent': 'Claim a sector next to your existing territory.',
    'unknown-recipient': 'That recipient has not joined this world yet.',
    'unknown-settlement': 'That settlement is no longer available.',
    'settlement-permission-denied': 'Your settlement role does not permit that action.',
    'settlement-invite-missing': 'You do not have an active invitation to that settlement.',
    'already-settlement-member': 'That player is already a member of this settlement.',
    'not-settlement-member': 'That player is not a member of this settlement.',
    'cannot-leave-settlement-owner': 'Transfer ownership before leaving your own settlement.',
    'cannot-remove-settlement-owner': 'Transfer ownership before removing the current owner.',
    'cannot-transfer-settlement-ownership-to-self':
      'Choose another settlement member as the owner.',
    'cannot-delete-settlement-owner':
      'Transfer ownership of every settlement before deleting this account.',
    'account-deletion-confirmation-required': 'Type DELETE exactly to confirm account deletion.',
    'account-deleted': 'This player identity has been permanently deleted.',
    unauthorized: 'Your connection cannot perform that action for this player.',
    'persistence-failed': 'The world could not save your action. It was not applied.',
  };
  return messages[code ?? ''] ?? `Action rejected: ${code ?? 'unknown reason'}.`;
};

export const setConnectionIndicator = (message: string, hidden = false) => {
  const indicator = document.getElementById('connection-indicator');
  if (!indicator) return;
  indicator.textContent = message;
  indicator.hidden = hidden;
};
