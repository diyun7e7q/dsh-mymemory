import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,existsSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {MemoryStore,scopeContext} from '../src/core.ts';
import {gateKey,contentHash,shingles,dice,minhash,jaccard,entropy,looksSecret,coreGrade,IncrementalGate} from '../src/gate.ts';
import {FileLock} from '../src/lock.ts';
import {unload,readSpill} from '../src/unload.ts';

function setup(t){
  const dir=mkdtempSync(join(tmpdir(),'mymemory-gate-'));
  const a=join(dir,'a');mkdirSync(a);mkdirSync(join(a,'.git'));
  const s=new MemoryStore(join(dir,'data','memory.sqlite'));
  t.after(()=>{s.close();rmSync(dir,{recursive:true,force:true});});
  return {dir,a,s,ctx:scopeContext(a)};
}
const makeGate=(s,percent=90)=>new IncrementalGate({store:s,lock:undefined,budgets:()=>({nearDupPercent:percent,extractionOutputTokens:256}),llm:()=>undefined,route:()=>undefined});
const input=(content,extra={})=>({content,category:'constraint',scope:'project',sourceType:'user_explicit',...extra});

test('normalization collapses spacing and punctuation before hashing',()=>{
  assert.equal(gateKey('预算 40 元'),gateKey('预算40元。'));
  assert.equal(contentHash('VPS  每月预算'),contentHash('vps每月预算!'));
  assert.notEqual(contentHash('预算40元'),contentHash('预算30元'));
});

test('near duplicates are separated from unrelated text with local math only',()=>{
  const a=shingles('我是自动化专业学生'),b=shingles('我是自动化专业的学生');
  assert.ok(dice(a,b)>0.7);
  assert.ok(jaccard(minhash('我是自动化专业学生'),minhash('我是自动化专业的学生'))>0.7);
  assert.ok(dice(a,shingles('今天天气不错'))<0.1);
  assert.equal(entropy('aaaaaaaaaa'),0);
});

test('secrets are caught by entropy, not just by known prefixes',()=>{
  assert.ok(looksSecret('api_key=sk-123456789abcdefghijk'));
  assert.ok(looksSecret('token ghp_16C7e42F292c6912E7710c838347Ae178B4a'));
  assert.ok(looksSecret('x9F2kQ7pL4mN8vB3cX6zA1sD5gH0jK2'));
  assert.ok(!looksSecret('VPS 每月预算最高 40 元'));
});

test('first level answers duplicate, near duplicate and secret without a model',t=>{
  const {s,ctx}=setup(t);
  const r=s.add(input('VPS 每月预算最高 40 元'),ctx);
  const dup=makeGate(s).firstLevel('VPS每月预算最高40元。');
  assert.equal(dup.action,'NOOP');
  assert.equal(dup.targetId,r.id);
  const near=makeGate(s,70).firstLevel('VPS 每月预算最高 40 元的');
  assert.equal(near.action,'MERGE');
  assert.equal(near.targetId,r.id);
  const secret=makeGate(s).firstLevel('api_key=sk-123456789abcdefghijk');
  assert.equal(secret.action,'NOOP');
  assert.equal(secret.reason,'secret');
});

test('only trusted global identity facts are A grade',t=>{
  const {s,ctx}=setup(t);
  const a=s.add({content:'我叫小明',category:'profile',scope:'global',sourceType:'user_explicit'},ctx);
  const b=s.add(input('这个项目用 SQLite'),ctx);
  const c=s.add({content:'我可能叫小刚',category:'profile',scope:'global',sourceType:'inferred'},ctx);
  assert.equal(coreGrade(a),true);
  assert.equal(coreGrade(b),false);
  assert.equal(coreGrade(c),false);
});

test('lock is exclusive while held and self-heals past ttl',t=>{
  const dir=mkdtempSync(join(tmpdir(),'mymemory-lock-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const path=join(dir,'.memory.lock');
  const lock=new FileLock(path,60000);
  assert.equal(lock.acquire(),true);
  assert.equal(existsSync(path),true);
  lock.release();
  assert.equal(existsSync(path),false);
  writeFileSync(path,JSON.stringify({pid:process.pid,at:Date.now()-120000}));
  const next=new FileLock(path,60000);
  assert.equal(next.acquire(),true);
  next.release();
});

test('oversized payload spills to disk and reads back by line',t=>{
  const dir=mkdtempSync(join(tmpdir(),'mymemory-spill-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  assert.equal(unload(dir,'small','短',{threshold:100}),undefined);
  const text=Array.from({length:300},(_,i)=>'line '+i).join('\n');
  const spill=unload(dir,'big',text,{threshold:100});
  assert.equal(spill.lines,300);
  assert.equal(spill.head[0],'line 0');
  assert.equal(spill.tail[spill.tail.length-1],'line 299');
  const page=readSpill(dir,spill.path,10,5);
  assert.deepEqual(page.lines,['line 10','line 11','line 12','line 13','line 14']);
  assert.equal(page.nextOffset,15);
  assert.throws(()=>readSpill(dir,join(dir,'..','outside.txt'),0,5));
});

test('A-grade change is queued for a human, and supersede keeps the old row addressable',t=>{
  const {s,ctx}=setup(t);
  const a=s.add({content:'我叫小明',category:'profile',scope:'global',sourceType:'user_explicit'},ctx);
  const id=s.raiseConflict({targetId:a.id,proposal:'我叫小红',reason:'core-grade-change'});
  assert.equal(s.conflicts().length,1);
  assert.equal(s.conflicts()[0].proposal,'我叫小红');
  const denied=s.resolveConflict(id,false,ctx);
  assert.equal(denied.conflict.status,'rejected');
  assert.equal(denied.record,undefined);
  assert.equal(s.conflicts().length,0);
  assert.equal(s.conflicts(true).length,1);
  const asked=s.raiseConflict({targetId:a.id,proposal:'我叫小红',reason:'core-grade-change'});
  const {record}=s.resolveConflict(asked,true,ctx);
  assert.equal(record.content,'我叫小红');
  const old=s.dump().find(r=>r.id===a.id);
  assert.equal(old.status,'superseded');
  assert.equal(old.supersededBy,record.id);
  assert.equal(record.supersedes,a.id);
});

test('ingest 一级命中照样落地：完全重复只刷新访问时间，不新增行',async(t)=>{
  const {s,ctx}=setup(t);
  const gate=makeGate(s);
  const first=await gate.ingest('每月 VPS 预算 40 元',ctx,input('每月 VPS 预算 40 元'));
  assert.equal(first.decision.action,'ADD');
  assert.equal(first.record.status,'active');
  const again=await gate.ingest('每月VPS预算40元。',ctx,input('每月VPS预算40元。'));
  assert.equal(again.decision.action,'NOOP');
  assert.equal(s.dump().length,1);
  assert.ok(s.get(first.record.id,ctx).lastAccessAt);
});

test('仲裁模型不在时，用户逐字给的内容不被降级成 pending',async(t)=>{
  const {s,ctx}=setup(t);
  const gate=makeGate(s,100);
  s.add({content:'VPS 预算每月 40 元，超出要先问我',category:'constraint',scope:'project',sourceType:'user_explicit'},ctx);
  const r=await gate.ingest('VPS 每月预算 45 元，超出要先问我',ctx,input('VPS 每月预算 45 元，超出要先问我'));
  assert.equal(r.decision.reason,'arbiter-unavailable');
  assert.equal(r.record.status,'active');
});
test('pending 也参与近重复：候选不会被同一句话再写一遍',async(t)=>{
  const {s,ctx}=setup(t);
  const gate=makeGate(s,100),cand=input('待确认样本：网关候选去重 alpha',{sourceType:'inferred',status:'pending'});
  const first=await gate.ingest(cand.content,ctx,cand);
  assert.equal(first.record.status,'pending');
  const again=await makeGate(s,100).ingest('待确认样本：网关候选去重 alpha。',ctx,input('待确认样本：网关候选去重 alpha。',{sourceType:'inferred',status:'pending'}));
  assert.equal(again.decision.action,'NOOP');
  assert.equal(s.dump().length,1);
});

test('pending 撞上用户亲口说的内容：合并时提为 active 并换成原话',t=>{
  const {s,ctx}=setup(t);
  const cand=s.add({content:'VPS 每月预算 40 元',category:'constraint',scope:'project',sourceType:'inferred',status:'pending'},ctx);
  assert.equal(cand.status,'pending');
  const out=makeGate(s,100).apply({action:'MERGE',content:'VPS 每月预算 50 元',targetId:cand.id,reason:'near-duplicate'},ctx,input('VPS 每月预算 50 元'));
  assert.equal(out.record.status,'active');
  assert.equal(out.record.content,'VPS 每月预算 50 元');
  assert.equal(s.dump().length,1);
});
