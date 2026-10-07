import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

test('recovered Supabase migrations match the normalized production ledger', () => {
  const manifestUrl = new URL('../supabase/production-migration-ledger.json', import.meta.url);
  const manifest = JSON.parse(readFileSync(manifestUrl, 'utf8'));
  assert.equal(manifest.project_id, 'eeapyxahorqwsmamnugn');
  assert.equal(manifest.migrations.length, 11);

  for (const migration of manifest.migrations) {
    const file = new URL(`../supabase/migrations/${migration.version}_${migration.name}.sql`, import.meta.url);
    const normalized = readFileSync(file, 'utf8').replaceAll('\r\n', '\n').replace(/\n+$/, '');
    const digest = createHash('md5').update(normalized).digest('hex');
    assert.equal(digest, migration.normalized_md5, `${migration.version}_${migration.name}.sql differs from production`);
  }
});
