// 跨对话记忆的验收：常驻块必须默认开启、必须覆盖身份之外的偏好与约束、
// 待确认的一律不进、字节必须稳定（否则每轮都撕前缀缓存）。
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {MemoryStore, scopeContext} from '../src/core.ts';
import {pack, estimateTokens, renderCore} from '../src/retrieval.ts';
import {DEFAULT_BUDGETS} from '../src/config.ts';

const dirs=[];
function setup(t){
  const dir=mkdtempSync(join(tmpdir(),'mymemory-core-'));
  dirs.push(dir);
  const a=join(dir,'a');
  mkdirSync(a);
  mkdirSync(join(a,'.git'));
  const ctx=scopeContext(a);
  const s=new MemoryStore(join(dir,'data','memory.sqlite'));
  t.after(()=>{s.close();rmSync(dir,{recursive:true,force:true})});
  return {s,ctx};
}
const rec=(content,category,extra={})=>({content,category,scope:'global',sourceType:'user_explicit',...extra});

test('core injection is on by default', ()=>{
  assert.ok(DEFAULT_BUDGETS.coreBudget>0, 'coreBudget 默认必须是正数，否则跨对话记忆默认不注入');
  assert.ok(DEFAULT_BUDGETS.coreBudget<=2048);
});

test('constraints and preferences are injected, not only identity', t=>{
  const {s,ctx}=setup(t);
  s.add(rec('自动化专业大三学生','profile'),ctx);
  s.add(rec('回答用简洁中文','preference'),ctx);
  s.add(rec('学校期间不许开代理','constraint'),ctx);
  s.add(rec('正在做 DSH 记忆插件','project'),ctx);
  const core=s.core(ctx);
  const cats=core.map(r=>r.category);
  assert.ok(cats.includes('preference'),'偏好必须进常驻块');
  assert.ok(cats.includes('constraint'),'约束必须进常驻块');
  assert.ok(!cats.includes('project'),'项目态不该常驻');
});

test('pending and expired records never enter the core block', t=>{
  const {s,ctx}=setup(t);
  s.add(rec('我喜欢苹果','preference'));
  s.add({content:'我可能喜欢梨',category:'preference',scope:'global',sourceType:'inferred',status:'pending'},ctx);
  s.add(rec('近期备考','preference',{expiresAt:'2000-01-01T00:00:00Z'}),ctx);
  const contents=s.core(ctx).map(r=>r.content);
  assert.deepEqual(contents,['我喜欢苹果']);
});

test('resident rendering drops metadata so more memories fit in the same bytes', t=>{
  const {s,ctx}=setup(t);
  for(const [content,category] of [
    ['自动化专业大三学生','profile'],
    ['回答用简洁中文','preference'],
    ['不许开代理','constraint'],
    ['目标院校南航','project']
  ]) s.add({content,category,scope:'global',sourceType:'user_explicit'},ctx);
  const core=s.core(ctx);
  const packed=pack(core,{budget:900});
  const rendered=renderCore(core,{budget:900});
  assert.ok(rendered.count>=core.length,'精简渲染能装下所有常驻条目');
  assert.ok(!rendered.text.includes('"id"'),'核心块不带 JSON 元数据');
  assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}-/.test(rendered.text),'核心块不泄露 id');
  assert.ok(rendered.text.includes('- [preference] 回答用简洁中文'));
  assert.ok(estimateTokens(rendered.text)<=900);
  assert.ok(estimateTokens(rendered.text)<estimateTokens(packed.text),'同样内容，精简渲染字节更少');
  assert.equal(rendered.text,renderCore(core,{budget:900}).text,'两次渲染字节相同');
});

test('identity sorts first, same category newest first', t=>{
  const {s,ctx}=setup(t);
  s.add(rec('回答用简洁中文','preference'),ctx);
  s.add(rec('自动化专业大三学生','profile'),ctx);
  s.add(rec('不许开代理','constraint'),ctx);
  const cats=s.core(ctx).map(r=>r.category);
  assert.deepEqual(cats,['profile','constraint','preference']);
});

test('core block fits its budget and is byte stable across renders', t=>{
  const {s,ctx}=setup(t);
  s.add(rec('自动化专业大三学生，目标院校南航，冲合工大','profile'),ctx);
  s.add(rec('回答用简洁中文，不要客套','preference'),ctx);
  const core=s.core(ctx);
  const first=pack(core,{budget:DEFAULT_BUDGETS.coreBudget});
  const second=pack(core,{budget:DEFAULT_BUDGETS.coreBudget});
  assert.ok(first.count>0,'常驻块至少塞进一条');
  assert.ok(estimateTokens(first.text)<=DEFAULT_BUDGETS.coreBudget,'不能超预算');
  assert.equal(first.text,second.text,'同一条记忆渲染两次必须字节相同');
  assert.ok(first.text.includes('自动化专业大三学生'));
});
