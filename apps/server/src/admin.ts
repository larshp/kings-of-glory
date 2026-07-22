import { pathToFileURL } from 'node:url';
import {
  createPostgresWorldPersistence,
  GlobalWorldHost,
  type AdministrativeInspectionRequest,
  type AdministrativeMutation,
} from '@kings/server-runtime';

type AdministrativeCliAction =
  | { readonly type: 'inspect'; readonly request: AdministrativeInspectionRequest }
  | { readonly type: 'inspect-audits'; readonly limit: number }
  | { readonly type: 'mutate'; readonly mutation: AdministrativeMutation };

const requireArgument = (value: string | undefined, usage: string) => {
  if (!value) throw new Error(`Missing argument. Usage: ${usage}`);
  return value;
};
const itemIds = ['ore', 'wood', 'ingot', 'tool'] as const;

export const parseAdministrativeCliArguments = (
  args: readonly string[],
): AdministrativeCliAction => {
  const [mode, operation, first, second, third] = args;
  if (mode === 'inspect') {
    if (operation === 'audits') {
      const limit = first === undefined ? 100 : Number(first);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500)
        throw new Error('Administrative audit limit must be between 1 and 500');
      return { type: 'inspect-audits', limit };
    }
    if (operation === 'world' || operation === 'transactions' || operation === 'moderation')
      return { type: 'inspect', request: { scope: operation } };
    if (operation === 'player' || operation === 'settlement')
      return {
        type: 'inspect',
        request: {
          scope: operation,
          id: requireArgument(first, `admin inspect ${operation} <id>`),
        },
      };
  }
  if (mode === 'mutate') {
    if (operation === 'set-player-inventory') {
      const item = requireArgument(
        second,
        'admin mutate set-player-inventory <player> <item> <amount>',
      );
      if (!itemIds.includes(item as (typeof itemIds)[number]))
        throw new Error(`Unknown item: ${item}`);
      const amount = Number(
        requireArgument(third, 'admin mutate set-player-inventory <player> <item> <amount>'),
      );
      return {
        type: 'mutate',
        mutation: {
          type: 'setPlayerInventory',
          playerId: requireArgument(
            first,
            'admin mutate set-player-inventory <player> <item> <amount>',
          ),
          item: item as (typeof itemIds)[number],
          amount,
        },
      };
    }
    if (operation === 'set-settlement-owner')
      return {
        type: 'mutate',
        mutation: {
          type: 'setSettlementOwner',
          settlementId: requireArgument(
            first,
            'admin mutate set-settlement-owner <settlement> <player>',
          ),
          playerId: requireArgument(
            second,
            'admin mutate set-settlement-owner <settlement> <player>',
          ),
        },
      };
    if (operation === 'remove-chat-message')
      return {
        type: 'mutate',
        mutation: {
          type: 'removeChatMessage',
          messageId: requireArgument(first, 'admin mutate remove-chat-message <message>'),
        },
      };
    if (operation === 'resolve-chat-report')
      return {
        type: 'mutate',
        mutation: {
          type: 'resolveChatReport',
          reportId: requireArgument(first, 'admin mutate resolve-chat-report <report>'),
        },
      };
  }
  throw new Error(
    'Usage: admin inspect <world|player|settlement|transactions|moderation|audits> [id|limit] or admin mutate <set-player-inventory|set-settlement-owner|remove-chat-message|resolve-chat-report> ...',
  );
};

const requiredEnvironment = (environment: NodeJS.ProcessEnv, name: string) => {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
};

export const runAdministrativeCli = async (
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
) => {
  const action = parseAdministrativeCliArguments(args);
  const persistence = createPostgresWorldPersistence(
    requiredEnvironment(environment, 'DATABASE_URL'),
  );
  const host = new GlobalWorldHost(1, persistence);
  try {
    await host.restore();
    if (action.type === 'inspect') return host.inspectAdministrative(action.request);
    if (action.type === 'inspect-audits') return host.administrativeAuditEvents(action.limit);
    if (environment.ADMIN_CONFIRM_OFFLINE !== 'YES')
      throw new Error(
        'ADMIN_CONFIRM_OFFLINE=YES is required; stop the game server before administrative mutations',
      );
    return host.mutateAdministrative({
      actorId: requiredEnvironment(environment, 'ADMIN_ACTOR'),
      reason: requiredEnvironment(environment, 'ADMIN_REASON'),
      mutation: action.mutation,
    });
  } finally {
    await host.close();
  }
};

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href)
  runAdministrativeCli(process.argv.slice(2), process.env)
    .then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
