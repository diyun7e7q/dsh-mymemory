import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {MemoryStore,scopeContext} from '../src/core.ts';

function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'mymemory-'));
  const a = join(dir, 'a');
  mkdirSync(join(a, '.git'), {recursive: true});
  const ctx = scopeContext(a);
  const s = new MemoryStore(join(dir, 'data', 'memory.sqlite'));
  t.after(() => { s.close(); rmSync(dir, {recursive: true, force: true}); });
  return {s, ctx};
}

const input = (content, extra = {}) => ({content, category: 'constraint', scope: 'project', sourceType: 'user_explicit', ...extra});

test('identifier compounds are retrievable by any of their parts', t => {
  const {s, ctx} = setup(t);
  s.add(input('插件仓库在 ~/work/dsh-mymemory，注入器叫 dsh-super-injector'), ctx);
  for (const q of ['injector', 'super', 'mymemory', 'dsh-super-injector']) assert.ok(s.search(q, ctx).length > 0, q);
});

test('widened boundary still refuses superstrings', t => {
  const {s, ctx} = setup(t);
  s.add(input('MyMemoryX 无关项目'), ctx);
  assert.equal(s.search('memory', ctx).length, 0);
  assert.equal(s.search('mymemoryzzz', ctx).length, 0);
});

test('temporal words no longer demote a confirmed fact', t => {
  const {s, ctx} = setup(t);
  const r = s.add(input('以前的仓库在 E:/old，过去三个版本都在那里'), ctx);
  assert.equal(r.status, 'active');
  assert.equal(s.search('仓库', ctx).length, 1);
});

test('speculation still lands in pending', t => {
  const {s, ctx} = setup(t);
  assert.equal(s.add(input('我可能选 A'), ctx).status, 'pending');
});

test('pending records are visible only when explicitly requested', t => {
  const {s, ctx} = setup(t);
  s.add(input('我可能选 B'), ctx);
  assert.equal(s.search('可能', ctx).length, 0);
  assert.equal(s.search('可能', ctx, {includePending: true}).length, 1);
});
