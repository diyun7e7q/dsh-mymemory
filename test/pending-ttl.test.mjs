// 没人再提的猜测会自己过期：这是"取消人工确认"的兜底。
// 反复出现的观察会被跨会话复现提正，一次性的噪音到点自己走。
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {MemoryStore, scopeContext} from '../src/core.ts';

function setup(t){
  const dir=mkdtempSync(join(tmpdir(),'mymemory-ttl-'));
  const a=join(dir,'a'); mkdirSync(a); mkdirSync(join(a,'.git'));
  const s=new MemoryStore(join(dir,'data','memory.sqlite'));
  t.after(()=>{s.close();rmSync(dir,{recursive:true,force:true});});
  return {s,ctx:scopeContext(a)};
}
const rec=(content,extra={})=>({content,category:'preference',scope:'global',sourceType:'inferred',status:'pending',...extra});
// 把一条记录的 updatedAt 挪到 N 天前，模拟"很久没被提起"
function age(s,id,days){
  const row=s.db.prepare('SELECT body FROM records WHERE id=?').get(id);
  const body=JSON.parse(row.body);
  body.updatedAt=new Date(Date.now()-days*86400000).toISOString();
  s.db.prepare('UPDATE records SET body=? WHERE id=?').run(JSON.stringify(body),id);
}

test('a pending guess nobody repeated is swept after the TTL', t=>{
  const {s,ctx}=setup(t);
  const old=s.add(rec('用户 可能喜欢深色界面'),ctx);
  age(s,old.id,10);
  assert.equal(s.sweepStalePending(7),1);
  assert.throws(()=>s.get(old.id,ctx),/NOT_FOUND/);
  assert.equal(s.dump().length,0);
});

test('a fresh pending guess survives', t=>{
  const {s,ctx}=setup(t);
  const fresh=s.add(rec('用户 好像喜欢深色界面'),ctx);
  age(s,fresh.id,3);
  assert.equal(s.sweepStalePending(7),0);
  assert.equal(s.dump().length,1);
});

test('confirmed memories are never swept, however old', t=>{
  const {s,ctx}=setup(t);
  const ok=s.add({content:'我在读自动化专业',category:'profile',scope:'global',sourceType:'user_explicit'},ctx);
  age(s,ok.id,365);
  assert.equal(ok.status,'active');
  assert.equal(s.sweepStalePending(7),0);
  assert.equal(s.dump().length,1);
});

test('sweeping is idempotent and keeps the index consistent', t=>{
  const {s,ctx}=setup(t);
  const a=s.add(rec('用户 可能用 Windows'),ctx);
  age(s,a.id,30);
  assert.equal(s.sweepStalePending(),1);
  assert.equal(s.sweepStalePending(),0,'第二次没有可扫的了');
  assert.equal(s.search('Windows',ctx).length,0,'索引里也要消失');
  assert.equal(s.db.prepare('SELECT count(*) n FROM revisions').get().n,0);
});
