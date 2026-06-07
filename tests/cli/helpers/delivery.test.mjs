/**
 * Unit tests for delivery helpers: findLatestDelivery, findResidualRisksSection.
 */
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  findLatestDelivery,
  findResidualRisksSection,
} from '../../../src/cli/helpers/delivery.mjs';

function makeTmpDir(prefix) {
  const dir = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('findLatestDelivery', () => {
  test('returns null when .harness/output does not exist', async () => {
    const dir = makeTmpDir('delivery-nooutput');
    try {
      expect(await findLatestDelivery(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('returns null when no delivery files are present', async () => {
    const dir = makeTmpDir('delivery-empty');
    try {
      const outputDir = join(dir, '.harness', 'output');
      mkdirSync(outputDir, { recursive: true });
      writeFileSync(join(outputDir, 'notes.md'), '# notes');

      expect(await findLatestDelivery(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('returns the lexicographically-latest delivery-*.md path', async () => {
    const dir = makeTmpDir('delivery-multi');
    try {
      const outputDir = join(dir, '.harness', 'output');
      mkdirSync(outputDir, { recursive: true });
      writeFileSync(join(outputDir, 'delivery-2026-01-01T00-00-00.md'), 'old');
      writeFileSync(join(outputDir, 'delivery-2026-06-01T00-00-00.md'), 'new');

      const latest = await findLatestDelivery(dir);
      expect(latest).toBe(join(outputDir, 'delivery-2026-06-01T00-00-00.md'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('findResidualRisksSection', () => {
  test('returns null when no Residual risks heading is present', () => {
    expect(findResidualRisksSection('# Delivery\n\nAll good.')).toBeNull();
  });

  test('extracts content under an "## Residual risks" heading up to the next heading', () => {
    const md = [
      '# Delivery',
      '',
      '## Residual risks',
      '- Some risk needing follow-up',
      '- Another risk',
      '',
      '## Next steps',
      'Nothing relevant here.',
    ].join('\n');

    const section = findResidualRisksSection(md);
    expect(section).toContain('Some risk needing follow-up');
    expect(section).toContain('Another risk');
    expect(section).not.toContain('Next steps');
  });

  test('also matches an "### Residual risks" heading', () => {
    const md = '### Residual risks\n- Sub-section risk\n## Done';
    const section = findResidualRisksSection(md);
    expect(section).toContain('Sub-section risk');
    expect(section).not.toContain('Done');
  });

  test('returns the rest of the document when the section is the last one', () => {
    const md = '## Residual risks\n- Final risk, no trailing heading';
    const section = findResidualRisksSection(md);
    expect(section).toContain('Final risk, no trailing heading');
  });
});
