import { createInterface } from 'node:readline/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createBackup, restoreBackup } from '../packages/core/backups.mjs';

const [action, file, flag] = process.argv.slice(2);
const home = process.env.PHONECLOUD_HOME || join(homedir(), '.phonecloud', 'data');
try {
  if (!file || !['backup', 'restore'].includes(action) || action === 'restore' && !['--preview', '--apply'].includes(flag)) {
    throw new Error('Usage: phonecloud backup FILE or phonecloud restore FILE --preview|--apply');
  }
  const input = createInterface({ input: process.stdin });
  const lines = input[Symbol.asyncIterator]();
  const { value: password } = await lines.next();
  input.close();
  const result = action === 'backup' ? await createBackup(home, resolve(file), password) : restoreBackup(home, resolve(file), password, flag === '--preview');
  console.log(JSON.stringify(result, null, 2));
} catch (error) { console.error(error.message); process.exitCode = 1; }
