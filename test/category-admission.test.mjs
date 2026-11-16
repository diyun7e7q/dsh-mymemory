// 常驻块的准入：项目进度不许冒充身份。用户不需要知道这个判断，也不需要任何标识。
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {MemoryStore, scopeContext} from '../src/core.ts';
import {longTermShape} from '../src/safety.ts';

function setup(t){
  const dir=mkdtempSync(join(tmpdir(),'mymemory-keep-'));
  const a=join(dir,'a'); mkdirSync(a); mkdirSync(join(a,'.git'));
  const s=new MemoryStore(join(dir,'data','memory.sqlite'));
  t.after(()=>{s.close();rmSync(dir,{recursive:true,force:true});});
  return {s,ctx:scopeContext(a)};
}
const add=(s,ctx,content,category)=>({...s.add({content,category,scope:'global',sourceType:'user_explicit'},ctx)});

test('long-term statements pass, progress reports do not', ()=>{
  assert.equal(longTermShape('自动化专业大三学生'),true);
  assert.equal(longTermShape('回答用简洁中文'),true);
  assert.equal(longTermShape('不擅自启停代理或 VPN'),true);
  assert.equal(longTermShape('正在改 mymemory 的注入段'),false);
  assert.equal(longTermShape('下一步先把 gate 的晋升补完'),false);
  assert.equal(longTermShape('日志在 E:/DSH/dsh-home 下面'),false);
  assert.equal(longTermShape('2026-11-16 把预算改成 1200'),false);
});

test('a progress report filed as profile is demoted, not lost', t=>{
  const {s,ctx}=setup(t);
  const r=add(s,ctx,'正在改 mymemory 的注入段','profile');
  assert.equal(r.category,'project','降级成项目，不进常驻块');
  assert.equal(s.get(r.id,ctx).content,'正在改 mymemory 的注入段','内容一个字都不改');
  assert.ok(!s.core(ctx).some(x=>x.id===r.id),'常驻块里看不到它');
});

test('a genuine long-term fact keeps its category', t=>{
  const {s,ctx}=setup(t);
  assert.equal(add(s,ctx,'自动化专业大三学生','profile').category,'profile');
  assert.equal(add(s,ctx,'回答用简洁中文','preference').category,'preference');
  assert.equal(add(s,ctx,'不擅自启停代理或 VPN','constraint').category,'constraint');
});

test('project and experience are untouched by the check', t=>{
  const {s,ctx}=setup(t);
  assert.equal(add(s,ctx,'正在做实验报告','project').category,'project');
  assert.equal(add(s,ctx,'正在做实验报告 II','experience').category,'experience');
});
