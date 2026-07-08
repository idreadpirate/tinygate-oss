// tinygate SDK tests — no model required. Run: node --test sdk.test.mjs
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs'; import os from 'node:os';
import { join } from 'node:path';
import { Tinygate, sigOf } from './sdk.mjs';
const tg = () => new Tinygate({ data: fs.mkdtempSync(join(os.tmpdir(), 'tgsdk-')) });

test('add returns a task id; status reflects it', async () => {
  const t = tg();
  const id = await t.add('fix parser', { prove: 'node -e "process.exit(1)"' });
  assert.match(id, /^[a-z0-9]+-[a-f0-9]+$/);
  assert.deepStrictEqual(await t.status(), { ready: 1, claimed: 0, done: 0 });
});
test('add --check throws on a born-green proof', async () => {
  await assert.rejects(() => tg().add('noop', { prove: 'node -e "process.exit(0)"', check: true }), /born-green|passes BEFORE/);
});
test('prove reports green/red honestly', async () => {
  const t = tg();
  assert.strictEqual((await t.prove('node -e "process.exit(0)"')).green, true);
  assert.strictEqual((await t.prove('node -e "process.exit(2)"')).exit, 2);
});
test('list returns queued tasks', async () => {
  const t = tg();
  await t.add('task one', { prove: 'node -e "process.exit(1)"' });
  const rows = await t.list('ready');
  assert.strictEqual(rows.length, 1);
  assert.match(rows[0].title, /task one/);
});
test('sigOf is re-exported and deterministic', () => {
  assert.strictEqual(sigOf({ repo: '/x', title: 'a 1', prove: 'p' }), sigOf({ repo: '/x', title: 'a 9', prove: 'p' }));
});
