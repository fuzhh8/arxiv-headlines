import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, 'dist');
const apiBaseUrl = String(process.env.ARXIV_API_BASE_URL || '').replace(/\/+$/, '');

rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });
cpSync(join(root, 'index.html'), join(output, 'index.html'));
cpSync(join(root, 'data'), join(output, 'data'), { recursive: true });
writeFileSync(
  join(output, 'config.js'),
  `window.ARXIV_HEADLINES_CONFIG = ${JSON.stringify({ apiBaseUrl }, null, 2)};\n`,
  'utf8'
);

console.log(`Static site built in ${output}`);
console.log(`Fetch API: ${apiBaseUrl || '(same origin / disabled on a static-only host)'}`);
