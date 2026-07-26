import { latestBackupFile, requireEnvironment } from './backup-tools.js';
import { runRestoreDrill } from './restore-drill.js';

const backupDirectory = requireEnvironment(process.env, 'BACKUP_OFFSITE_DIR');
const backupFile = await latestBackupFile(backupDirectory);
const report = await runRestoreDrill({ ...process.env, BACKUP_FILE: backupFile });
process.stdout.write(
  `${JSON.stringify({ event: 'scheduled-restore.verified', backupFile, ...report })}\n`,
);
