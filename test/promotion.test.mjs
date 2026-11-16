// 写入侧的验收：模型抽出来的事实如果只出现一次，就老老实实待在待确认区；
// 在另一个会话里再次出现，才算佐证升为 active。宁漏勿错。
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {MemoryStore, scopeContext} from '../src/core.ts';
import {IncrementalGate} from '../src/gate.ts';

function setup(t){
  const dir=mkdtempSync(join(tmpdir(),'mymemory-promote-'));
  const a=join(dir,'a'); mkdirSync(a); mkdirSync(join(a,'.git'));
  const s=new MemoryStore(join(dir,'data','memory.sqlite'));
  t.after(()=>{s.close();rmSync(dir,{recursive:true,force:true});});
  return {s,ctx:scopeContext(a)};
}
const makeGate=(s)=>new IncrementalGate({store:s,lock:undefined,budgets:()=>({nearDupPercent:90,extractionOutputTokens:256}),llm:()=>undefined,route:()=>undefined});
const pending=(sessionId,messageId='1')=>({content:'用户 习惯在晚上写代码',category:'profile',scope:'global',sourceType:'inferred',status:'pending',sourceRef:{sessionId,messageId}});

test('a single-session observation stays pending', t=>{
  const {s,ctx}=setup(t); const gate=makeGate(s);
  const a=s.add(pending('s1'),ctx);
  assert.equal(a.status,'pending');
  // 同一会话再次命中：不是独立观察，不提正
  const r=gate.apply({action:'NOOP',targetId:a.id,content:a.content,reason:'exact-duplicate'},ctx,{content:a.content,scope:'global',sourceType:'inferred',sourceRef:{sessionId:'s1',messageId:'9'}});
  assert.equal(r.record.status,'pending');
});

test('the same observation in a second conversation is promoted', t=>{
  const {s,ctx}=setup(t); const gate=makeGate(s);
  const a=s.add(pending('s1'),ctx);
  const r=gate.apply({action:'NOOP',targetId:a.id,content:a.content,reason:'exact-duplicate'},ctx,{content:a.content,scope:'global',sourceType:'inferred',sourceRef:{sessionId:'s2',messageId:'3'}});
  assert.equal(r.record.status,'active','跨会话复现要提正');
  assert.equal(r.record.sourceType,'user_confirmed','提正后要标明是确认过的');
});

test('near duplicate from another conversation promotes too', t=>{
  const {s,ctx}=setup(t); const gate=makeGate(s);
  const a=s.add(pending('s1'),ctx);
  const variant='用户 习惯在晚上写代码。';
  const r=gate.apply({action:'MERGE',targetId:a.id,content:variant,reason:'near-duplicate'},ctx,{content:variant,scope:'global',sourceType:'inferred',sourceRef:{sessionId:'s3',messageId:'5'}});
  assert.equal(r.record.status,'active');
});

test('user-stated content is still promoted without waiting for a second conversation', t=>{
  const {s,ctx}=setup(t); const gate=makeGate(s);
  const a=s.add(pending('s1'),ctx);
  const r=gate.apply({action:'MERGE',targetId:a.id,content:'用户 习惯在晚上写代码！',reason:'near-duplicate'},ctx,{content:'用户 习惯在晚上写代码！',scope:'global',sourceType:'user_explicit',sourceRef:{sessionId:'s1',messageId:'4'}});
  assert.equal(r.record.status,'active','用户亲口说的当场生效');
});
