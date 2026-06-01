import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { run } from 'node:test';
import { spec } from 'node:test/reporters';

async function findTests(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await findTests(full));
    else if (entry.name.endsWith('.test.mjs')) files.push(full);
  }
  return files;
}

const files = await findTests('tests');
const stream = run({ files });
stream.compose(spec).pipe(process.stdout);
stream.on('test:fail', () => { process.exitCode = 1; });
