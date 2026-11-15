import {test} from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,mkdirSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {MemoryStore,scopeContext} from '../src/core.ts';
import {WorkStore,VERIFY_THRESHOLD} from '../src/work.ts';

function setup(t){
  const dir=mkdtempSync(join(tmpdir(),'mymemory-stage-'));mkdirSync(join(dir,'a'));
  const s=new MemoryStore(join(dir,'m.sqlite'));const w=new WorkStore(s);
  const ctx=scopeContext(join(dir,'a'),'sess-a');const ctxB=scopeContext(join(dir,'a'),'sess-b');
  t.after(()=>{s.close();rmSync(dir,{recursive:true,force:true});});
  const evidence=s.add({content:'本项目构建流程已通过测试验证',category:'experience',scope:'project',sourceType:'user_confirmed'},ctx);
  return {s,w,ctx,ctxB,evidence};
}
function enabled(w,ctx,evidence){
  const d=w.proposeSkill({name:'mymemory-stage-flow',title:'构建流程',description:'修改本项目后检查构建',body:'先检查类型，再构建并跑测试。',evidenceIds:[evidence.id]},ctx);
  const v=w.validateSkill(d.id,d.version,ctx,{userApproved:true});
  return w.setSkillState(d.id,v.version,'active',ctx);
}
const live=(w,id,ctx)=>{const r=w.get(id,ctx);return r.activeRevision??r.version;};

test('新技能默认 candidate：同一会话重复成功不转正',t=>{
  const {w,ctx,evidence}=setup(t);
  const d=w.proposeSkill({name:'mymemory-stage-solo',title:'构建',description:'本项目构建',body:'先检查类型再构建。',evidenceIds:[evidence.id]},ctx);
  assert.equal(d.stage,'candidate');
  const active=enabled(w,ctx,evidence);
  w.recordUse({id:active.id,version:live(w,active.id,ctx),outcome:'success',evidenceIds:[evidence.id]},ctx);
  const after=w.get(active.id,ctx);
  assert.equal(after.verifiedCount,1);
  assert.equal(after.stage,'candidate','一次成功还不够，单会话反复成功不能自我转正');
});

test('两个不同会话各自成功一次才转正为 verified',t=>{
  const {w,ctx,ctxB,evidence}=setup(t);
  const active=enabled(w,ctx,evidence);
  w.recordUse({id:active.id,version:live(w,active.id,ctx),outcome:'success',evidenceIds:[evidence.id]},ctx);
  w.recordUse({id:active.id,version:live(w,active.id,ctx),outcome:'success',evidenceIds:[evidence.id]},ctxB);
  const after=w.get(active.id,ctx);
  assert.equal(after.verifiedCount,VERIFY_THRESHOLD);
  assert.equal(after.stage,'verified');
});

test('同一会话成功多次只算一次',t=>{
  const {w,ctx,evidence}=setup(t);
  const active=enabled(w,ctx,evidence);
  for(let i=0;i<3;i++)w.recordUse({id:active.id,version:live(w,active.id,ctx),outcome:'success',evidenceIds:[evidence.id]},ctx);
  const after=w.get(active.id,ctx);
  assert.equal(after.verifiedCount,1);
  assert.equal(after.stage,'candidate');
});

test('连续两次失败即废弃并停用',t=>{
  const {w,ctx,evidence}=setup(t);
  const active=enabled(w,ctx,evidence);
  w.recordUse({id:active.id,version:live(w,active.id,ctx),outcome:'failure',evidenceIds:[evidence.id]},ctx);
  assert.equal(w.get(active.id,ctx).failures,1);
  w.recordUse({id:active.id,version:live(w,active.id,ctx),outcome:'failure',evidenceIds:[evidence.id]},ctx);
  const after=w.get(active.id,ctx);
  assert.equal(after.stage,'deprecated');
  assert.equal(after.status,'disabled');
  assert.equal(w.catalog(ctx).length,0);
});

test('人工裁决可一键转正或废弃，卡片不带正文',t=>{
  const {w,ctx,evidence}=setup(t);
  const active=enabled(w,ctx,evidence);
  const promoted=w.setSkillStage(active.id,active.version,'verified',ctx);
  assert.equal(promoted.stage,'verified');
  const cards=w.cards('构建',ctx);
  assert.equal(cards.length,1);
  assert.equal(cards[0].stage,'verified');
  assert.equal(cards[0].body,undefined,'卡片只给身份，正文靠展开');
  w.setSkillStage(promoted.id,promoted.version,'deprecated',ctx);
  assert.equal(w.cards('',ctx).length,0);
  assert.equal(w.get(active.id,ctx).stage,'deprecated');
});
