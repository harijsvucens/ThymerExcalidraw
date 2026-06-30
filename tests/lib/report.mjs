// Report writer shared by all tests.
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..');
const REPORT_DIR = join(PROJECT_ROOT, 'tests', 'baseline');
mkdirSync(REPORT_DIR, { recursive: true });

export function writeReport(name, data) {
  const path = join(REPORT_DIR, `${name}.json`);
  writeFileSync(path, JSON.stringify(data, null, 2));
  return path;
}

export { PROJECT_ROOT, REPORT_DIR };
