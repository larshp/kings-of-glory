import { describe, expect, it } from 'vitest';
import { createStructuredLogger } from '../src/logger.js';

describe('structured logger', () => {
  it('uses configured severity as a threshold rather than an event label', () => {
    const lines: string[] = [];
    const logger = createStructuredLogger('warn', (line) => lines.push(line));

    logger.debug('debug.event');
    logger.info('info.event');
    logger.warn('warn.event', { playerId: 'player-a' });
    logger.error('error.event');

    expect(lines.map((line) => JSON.parse(line))).toEqual([
      { playerId: 'player-a', level: 'warn', event: 'warn.event' },
      { level: 'error', event: 'error.event' },
    ]);
  });

  it('does not let metadata override reserved log fields', () => {
    const lines: string[] = [];
    const logger = createStructuredLogger('debug', (line) => lines.push(line));

    logger.info('server.started', { level: 'error', event: 'forged', port: 3001 });

    expect(JSON.parse(lines[0]!)).toEqual({
      level: 'info',
      event: 'server.started',
      port: 3001,
    });
  });
});
