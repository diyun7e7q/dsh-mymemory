import {test} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {MemoryStore} from '../src/core.ts';
import {createPanelHandler} from '../src/panel.ts';
import {finishCleanup, writePointer} from '../src/location.ts';
import {WorkStore} from '../src/work.ts';

function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'mymemory-panel-'));
  mkdirSync(join(dir, 'data'));
  const store = new MemoryStore(join(dir, 'data', 'memory.sqlite'));
  const saved = [];
  t.after(() => {
    store.close();
    rmSync(dir, {recursive: true, force: true});
  });
  const handler = createPanelHandler({
    store,work:new WorkStore(store),getCwd:()=>dir,authorize:req=>req.headers.cookie==='test-owner',
    dataDir: join(dir, 'data'),
    home: dir,
    soulDir: dir,
    soul: {chars: 0, missing: true, overLimit: false},
    onSoulSaved: (text) => saved.push(text),
  });
  return {store, handler, dir, saved};
}

function rawRequest(handler, {method = 'POST', body, headers = {}, remote = '127.0.0.1'} = {}) {
  const req = {
    method,
    headers,
    socket: {remoteAddress: remote},
    destroy() {},
  };
  const listeners = new Map();
  req.on = (event, cb) => {
    if (!listeners.has(event)) listeners.set(event, []);
    listeners.get(event).push(cb);
    return req;
  };
  const res = {
    statusCode: 0,
    body: '',
    writeHead(code) {
      this.statusCode = code;
    },
    end(payload) {
      this.body = payload;
    },
  };
  const done = handler(req, res).then(() => ({status: res.statusCode, json: JSON.parse(res.body || 'null')}));
  setImmediate(() => {
    for (const cb of listeners.get('data') || []) cb(Buffer.from(JSON.stringify(body ?? {}), 'utf8'));
    for (const cb of listeners.get('end') || []) cb();
  });
  return done;
}
const tokens=new WeakMap();
async function request(handler,options={}){
 const headers={'content-type':'application/json','x-mymemory-client':'1',cookie:'test-owner',host:'127.0.0.1:51922',origin:'http://127.0.0.1:51922',...options.headers};
 if(!tokens.has(handler)){const r=await rawRequest(handler,{body:{op:'bootstrap'},headers});if(r.json?.data?.token)tokens.set(handler,r.json.data.token);}
 return rawRequest(handler,{...options,headers:{...headers,'x-mymemory-token':tokens.get(handler)??''}});
}
test('unauthenticated loopback and cross-site requests cannot read private memories',async t=>{const{handler}=setup(t);assert.equal((await rawRequest(handler,{body:{op:'read'}})).status,401);assert.equal((await rawRequest(handler,{headers:{cookie:'test-owner','content-type':'application/json','x-mymemory-client':'1',host:'127.0.0.1',origin:'https://evil.invalid'},body:{op:'bootstrap'}})).status,403);assert.equal((await request(handler,{body:{op:'read'}})).status,200);});
test('forged local origin and client headers cannot obtain an owner capability',async t=>{const{handler}=setup(t);assert.equal((await rawRequest(handler,{headers:{'content-type':'application/json','x-mymemory-client':'1',host:'127.0.0.1',origin:'http://127.0.0.1'},body:{op:'bootstrap'}})).status,401);});
test('panel saves handoffs and supports verified skill activation in the same project',async t=>{const{handler,store,dir}=setup(t);const evidence=store.add({content:'用户确认这个构建流程经过检查',scope:'project',sourceType:'user_confirmed',category:'experience'},(await import('../src/core.ts')).scopeContext(dir));const h=await request(handler,{body:{op:'handoff_save',taskId:'panel-task',title:'交接',body:'完成类型检查；下一步桌面验收',evidenceIds:[evidence.id]}});assert.equal(h.status,200);assert.equal(h.json.data.handoffs.length,1);const d=await request(handler,{body:{op:'skill_propose',name:'mymemory-panel-build',title:'构建检查',description:'构建本项目时使用',body:'类型检查、构建和测试。',evidenceIds:[evidence.id]}});assert.equal(d.status,200);const s=d.json.data.skills[0];const v=await request(handler,{body:{op:'skill_validate',id:s.id,expectedVersion:s.version}});assert.equal(v.status,200);assert.equal(v.json.data.skills[0].status,'validated');});

test('read 返回设定与记忆条目', async (t) => {
  const {store, handler, dir} = setup(t);
  writeFileSync(join(dir, 'SOUL.md'), '你是测试人格。', 'utf8');
  store.add({content: '用户讨厌绕圈试错', category: 'preference', scope: 'global', sourceType: 'user_explicit'}, {});
  const {status, json} = await request(handler, {body: {op: 'read'}});
  assert.equal(status, 200);
  assert.equal(json.ok, true);
  assert.equal(json.data.soul.text, '你是测试人格。');
  assert.equal(json.data.soul.chars, 7);
  assert.equal(json.data.records.length, 1);
  assert.equal(json.data.records[0].content, '用户讨厌绕圈试错');
});

test('soul 写入落盘并推回注入层', async (t) => {
  const {handler, dir, saved} = setup(t);
  const {status, json} = await request(handler, {body: {op: 'soul', text: '新的人格'}});
  assert.equal(status, 200);
  assert.equal(readFileSync(join(dir, 'SOUL.md'), 'utf8'), '新的人格');
  assert.equal(json.data.soul.chars, 4);
  assert.deepEqual(saved, ['新的人格']);
});

test('new 写一条、edit 改一条、forget 删一条', async (t) => {
  const {handler} = setup(t);
  const created = await request(handler, {body: {op: 'new', content: 'Qname 用 Windows', category: 'profile'}});
  assert.equal(created.json.data.records.length, 1);
  const id = created.json.data.records[0].id;
  assert.equal(created.json.data.records[0].category, 'profile');

  const edited = await request(handler, {body: {op: 'edit', id, expectedVersion:1, content: 'Qname 用 Windows 和 DSH'}});
  assert.equal(edited.status, 200);
  assert.equal(edited.json.data.records[0].content, 'Qname 用 Windows 和 DSH');
  assert.equal(edited.json.data.records[0].status, 'active');

  const removed = await request(handler, {body: {op: 'forget', id}});
  assert.equal(removed.status, 200);
  assert.equal(removed.json.data.records.length, 0);
});

test('空内容与未知 op 被拒，且不写盘', async (t) => {
  const {handler} = setup(t);
  const empty = await request(handler, {body: {op: 'new', content: '   '}});
  assert.equal(empty.status, 400);
  assert.equal(empty.json.error, 'EMPTY_CONTENT');
  const unknown = await request(handler, {body: {op: 'write', budgets: {coreBudget: 1}}});
  assert.equal(unknown.status, 400);
  assert.equal(unknown.json.error, 'INVALID_OP');
});

test('online relocation freezes old writes and reports restart requirement', async t=>{
 const {handler,store,dir}=setup(t);store.add({content:'迁移前重要记录',scope:'global',sourceType:'user_explicit'},{});
 const target=join(dir,'moved');const r=await request(handler,{body:{op:'move',dir:target}});
 assert.equal(r.status,200);assert.equal(r.json.data.restartRequired,true);assert.equal(r.json.data.movedTo,target);assert.equal(store.search('重要记录',{}).length,1);assert.throws(()=>store.add({content:'旧库停写',scope:'global',sourceType:'user_explicit'},{}),/STORE_MIGRATING/);
});

test('GET 与非同源请求被挡', async (t) => {
  const {handler, dir} = setup(t);
  assert.equal((await request(handler, {method: 'GET'})).status, 405);
  const noOrigin = await request(handler, {remote: '10.0.0.9', body: {op: 'read'}});
  assert.equal(noOrigin.status, 403);
  const crossSite = await request(handler, {
    remote: '10.0.0.9',
    headers: {host: '127.0.0.1:51922', origin: 'https://evil.example'},
    body: {op: 'read'},
  });
  assert.equal(crossSite.status, 403);
  assert.equal(existsSync(join(dir, 'SOUL.md')), false);
});

test('cleanup 没有原目录时拒绝', async (t) => {
  const {handler} = setup(t);
  assert.equal((await request(handler, {body: {op: 'cleanup'}})).json.error, 'MIGRATION_PROOF_REQUIRED');
});

test('startup never deletes an old directory from a stale pointer', async t=>{
 const {handler,dir}=setup(t);const previous=join(dir,'old');mkdirSync(previous);writeFileSync(join(previous,'memory.sqlite'),'private data');
 writePointer(dir,{dataDir:join(dir,'data'),previous,pendingCleanup:previous});
 assert.equal((await request(handler,{body:{op:'cleanup'}})).json.error,'MIGRATION_PROOF_REQUIRED');
 assert.deepEqual(finishCleanup(dir,join(dir,'data')),[]);assert.equal(readFileSync(join(previous,'memory.sqlite'),'utf8'),'private data');
});

test('finishCleanup 不删当前正在用的目录', async (t) => {
  const {dir} = setup(t);
  const current = join(dir, 'data');
  writePointer(dir, {dataDir: current, pendingCleanup: current});
  assert.deepEqual(finishCleanup(dir, current), []);
  assert.equal(existsSync(join(current, 'memory.sqlite')), true);
});
