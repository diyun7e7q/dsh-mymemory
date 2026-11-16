import {randomUUID} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import type {MemoryStore,ScopeContext} from './core.ts';
import {fail,text,sensitive,suspicious} from './safety.ts';

export type SkillStage='candidate'|'verified'|'deprecated';
export type WorkRecord={id:string;kind:'handoff'|'skill';version:number;scope:string;scopeId:string;title:string;body:string;status:string;createdAt:string;updatedAt:string;taskId?:string;name?:string;description?:string;activeRevision?:number;review?:string;stage?:SkillStage;verifiedCount?:number;failures?:number;lastVerifiedAt?:string;verifiedSessions?:string[];sourceRef?:{sessionId?:string;messageId?:string};evidenceIds:string[]};
/** 转正门槛：两个不同会话各自成功用过一次，才算这条经验真的可复用。 */
export const VERIFY_THRESHOLD=2;
type WorkInput={id?:string;expectedVersion?:number;scope?:string;taskId?:string;title:string;body:string;name?:string;description?:string;evidenceIds?:string[];sourceRef?:WorkRecord['sourceRef']};
function visible(r:any,ctx:ScopeContext){return r.scope==='global'||r.scopeId===ctx[r.scope as 'workspace'|'project'];}
function safe(value:unknown,max:number){const v=text(value,max);if(sensitive(v))fail('SENSITIVE_CONTENT_REJECTED');if(suspicious(v))fail('UNSAFE_CONTENT');return v;}
export function initWork(db:DatabaseSync){db.exec(`
 CREATE TABLE IF NOT EXISTS work_objects(id TEXT PRIMARY KEY,body TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS work_revisions(id TEXT NOT NULL,version INTEGER NOT NULL,body TEXT NOT NULL,PRIMARY KEY(id,version));
 CREATE TABLE IF NOT EXISTS work_dependencies(parent TEXT NOT NULL,version INTEGER NOT NULL,source TEXT NOT NULL,source_version INTEGER NOT NULL,source_kind TEXT NOT NULL,PRIMARY KEY(parent,version,source));
 CREATE INDEX IF NOT EXISTS work_source ON work_dependencies(source);
 CREATE TABLE IF NOT EXISTS work_uses(id TEXT PRIMARY KEY,skill_id TEXT NOT NULL,version INTEGER NOT NULL,body TEXT NOT NULL);
`);}
/** Called inside the owner's delete transaction. All historical dependent bodies are removed. */
export function purgeDerived(db:DatabaseSync,source:string){
 const queue=[source],seen=new Set<string>();
 while(queue.length){const id=queue.shift()!;if(seen.has(id))continue;seen.add(id);for(const row of db.prepare('SELECT DISTINCT parent FROM work_dependencies WHERE source=?').all(id) as any[])queue.push(row.parent);for(const row of db.prepare('SELECT body FROM records').all() as any[]){const r=JSON.parse(row.body);if(r.relations?.includes(id))queue.push(r.id);}}
 for(const id of seen){for(const table of ['work_objects','work_revisions','records','terms','revisions'])db.prepare(`DELETE FROM ${table} WHERE id=?`).run(id);db.prepare('DELETE FROM work_dependencies WHERE parent=? OR source=?').run(id,id);db.prepare('DELETE FROM work_uses WHERE skill_id=?').run(id);db.prepare('INSERT OR IGNORE INTO tombstones VALUES (?)').run(id);}
}
export class WorkStore{
 store:MemoryStore;
 constructor(store:MemoryStore){this.store=store;initWork(store.db);}
 private raw(id:string,version?:number):WorkRecord|undefined{const row=(version===undefined?this.store.db.prepare('SELECT body FROM work_objects WHERE id=?').get(id):this.store.db.prepare('SELECT body FROM work_revisions WHERE id=? AND version=?').get(id,version)) as any;return row?JSON.parse(row.body):undefined;}
 private audienceAllows(parent:WorkRecord,source:any){return !(parent.scope==='global'&&source.scope!=='global'||parent.scope==='project'&&source.scope==='workspace');}
 private dependenciesVisible(r:WorkRecord,ctx:ScopeContext,seen=new Set<string>()):boolean{if(seen.has(r.id))return false;seen.add(r.id);try{for(const id of r.evidenceIds){const source=this.source(id,ctx);if(!this.audienceAllows(r,source.record))return false;if(source.kind==='work'&&!this.dependenciesVisible(source.record as WorkRecord,ctx,new Set(seen)))return false;}return true;}catch{return false;}}
 get(id:string,ctx:ScopeContext){text(id,100);const r=this.raw(id);if(!r||!visible(r,ctx)||!this.dependenciesVisible(r,ctx))fail('NOT_FOUND');return r;}
 list(kind:'handoff'|'skill',ctx:ScopeContext){return this.store.db.prepare('SELECT body FROM work_objects').all().map((x:any)=>JSON.parse(x.body) as WorkRecord).filter(r=>r.kind===kind&&visible(r,ctx)&&this.dependenciesVisible(r,ctx)).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)).slice(0,100);}
 private source(id:string,ctx:ScopeContext){const work=this.raw(id);if(work){if(!visible(work,ctx)||work.status==='disabled')fail('SOURCE_UNAVAILABLE');return {kind:'work',record:work};}try{const r=this.store.get(id,ctx);if(r.status!=='active'||r.evidence==='unconfirmed'||r.expiresAt&&Date.parse(r.expiresAt)<=Date.now()||r.reviewAt&&Date.parse(r.reviewAt)<=Date.now())fail('SOURCE_UNAVAILABLE');return {kind:'memory',record:r};}catch{fail('SOURCE_UNAVAILABLE');}}
 private wouldCycle(id:string,sourceId:string,seen=new Set<string>()):boolean{
   if(sourceId===id)return true;
   if(seen.has(sourceId))return false;seen.add(sourceId);
   const src=this.raw(sourceId);if(!src||src.kind!=='skill'&&src.kind!=='handoff')return false;
   return (src.evidenceIds??[]).some(e=>this.wouldCycle(id,e,seen));
 }
 private dependencies(r:WorkRecord,ctx:ScopeContext){
   for(const id of r.evidenceIds){if(this.wouldCycle(r.id,id))fail('DEPENDENCY_CYCLE');const source=this.source(id,ctx);if(!this.audienceAllows(r,source.record))fail('SCOPE_EXPANSION');this.store.db.prepare('INSERT OR REPLACE INTO work_dependencies VALUES (?,?,?,?,?)').run(r.id,r.version,id,source.record.version,source.kind);}
 }
 private currentSources(r:WorkRecord,ctx:ScopeContext,seen=new Set<string>()):boolean{
   if(seen.has(r.id))return false;seen.add(r.id);
   try{for(const d of this.store.db.prepare('SELECT * FROM work_dependencies WHERE parent=? AND version=?').all(r.id,r.version) as any[]){const current=this.source(d.source,ctx);if(current.record.version!==d.source_version)return false;if(current.kind==='work'&&!this.currentSources(current.record as WorkRecord,ctx,new Set(seen)))return false;}return true;}catch{return false;}
 }
 private put(r:WorkRecord,ctx:ScopeContext){const old=this.raw(r.id);if(old)this.store.db.prepare('INSERT OR REPLACE INTO work_revisions VALUES (?,?,?)').run(old.id,old.version,JSON.stringify(old));this.dependencies(r,ctx);this.store.db.prepare('INSERT OR REPLACE INTO work_objects VALUES (?,?)').run(r.id,JSON.stringify(r));this.store.setting('writeEpoch',(this.store.setting('writeEpoch')??0)+1);return r;}
 private make(kind:'handoff'|'skill',input:WorkInput,ctx:ScopeContext,old?:WorkRecord):WorkRecord{
   const scope=old?.scope??input.scope??'project';if(!['global','workspace','project'].includes(scope))fail('INVALID_SCOPE');const scopeId=scope==='global'?'global':ctx[scope as 'workspace'|'project'];if(!scopeId)fail('SCOPE_UNAVAILABLE');
   const body=safe(input.body,2000);if(Buffer.byteLength(body)> (kind==='skill'?2048:3072))fail('BODY_BUDGET_EXCEEDED');
   if(input.evidenceIds!==undefined&&(!Array.isArray(input.evidenceIds)||input.evidenceIds.length>20||input.evidenceIds.some(id=>typeof id!=='string')))fail('INVALID_EVIDENCE');
   const now=new Date().toISOString();return{id:old?.id??randomUUID(),kind,version:(old?.version??0)+1,scope,scopeId,title:safe(input.title,160),body,status:kind==='skill'?'draft':'ready',...(kind==='skill'?{stage:old?.stage??('candidate' as SkillStage),verifiedCount:old?.verifiedCount??0,failures:old?.failures??0,verifiedSessions:old?.verifiedSessions??[]}:{}),createdAt:old?.createdAt??now,updatedAt:now,evidenceIds:[...new Set(input.evidenceIds??[])],sourceRef:input.sourceRef,...(old?.activeRevision?{activeRevision:old.activeRevision}:{})};
 }
 saveHandoff(input:WorkInput,ctx:ScopeContext){return this.store.transaction(()=>{
   const taskId=safe(input.taskId,160);const existing=input.id?this.get(input.id,ctx):this.list('handoff',ctx).find(r=>r.taskId===taskId&&r.scope===(input.scope??'project'));
   if(input.expectedVersion!==undefined&&!existing)fail('NOT_FOUND');if(existing&&(existing.kind!=='handoff'||existing.taskId!==taskId))fail('VERSION_CONFLICT');
   if(existing){if(input.expectedVersion===undefined&&existing.body===input.body&&existing.title===input.title&&JSON.stringify(existing.evidenceIds)===JSON.stringify(input.evidenceIds??[]))return existing;if(input.expectedVersion!==existing.version)fail('VERSION_CONFLICT');}
   if(!existing&&this.list('handoff',ctx).length>=100)fail('HANDOFF_LIMIT');
   return this.put({...this.make('handoff',input,ctx,existing),taskId},ctx);
 });}
 proposeSkill(input:WorkInput,ctx:ScopeContext){return this.store.transaction(()=>{
   if(typeof input.name!=='string'||!/^mymemory-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.name)||input.name.length>100)fail('INVALID_SKILL_NAME');
   const old=input.id?this.get(input.id,ctx):undefined;if(old&&(old.kind!=='skill'||old.name!==input.name))fail('INVALID_SKILL');
   if(old&&input.expectedVersion!==old.version)fail('VERSION_CONFLICT');
   if(!old&&this.list('skill',ctx).some(r=>r.name===input.name))fail('NAME_CONFLICT');if(!old&&this.list('skill',ctx).length>=100)fail('SKILL_LIMIT');if((old?.version??0)>=10)fail('REVISION_LIMIT');
   if(!input.evidenceIds?.length)fail('EVIDENCE_REQUIRED');
   return this.put({...this.make('skill',input,ctx,old),name:input.name,description:safe(input.description,256)},ctx);
 });}
 validateSkill(id:string,version:number,ctx:ScopeContext,{userApproved=false}={}){return this.store.transaction(()=>{const r=this.get(id,ctx);if(r.kind!=='skill')fail('INVALID_SKILL');if(r.version!==version)fail('VERSION_CONFLICT');if(!userApproved)fail('REVIEW_REQUIRED');if(!r.evidenceIds.length||!this.currentSources(r,ctx))fail('SOURCE_UNAVAILABLE');return this.put({...r,version:r.version+1,status:'validated',review:'user_reviewed; not an automated success proof',updatedAt:new Date().toISOString()},ctx);});}
 setSkillState(id:string,version:number,state:string,ctx:ScopeContext){return this.store.transaction(()=>{const r=this.get(id,ctx);if(r.kind!=='skill'||!['active','disabled'].includes(state))fail('INVALID_STATE');if(r.version!==version)fail('VERSION_CONFLICT');if(state==='active'&&r.status!=='validated')fail('NOT_VALIDATED');if(!this.currentSources(r,ctx))fail('SOURCE_UNAVAILABLE');const next={...r,version:r.version+1,status:state,updatedAt:new Date().toISOString()};if(state==='active')next.activeRevision=next.version;else delete next.activeRevision;return this.put(next,ctx);});}
 private active(r:WorkRecord,ctx:ScopeContext){if(!r.activeRevision)return undefined;const version=r.activeRevision===r.version?r:this.raw(r.id,r.activeRevision);return version&&this.currentSources(version,ctx)?version:undefined;}
  /** 证据齐全就启用：主人要的是"记下来当场能用"，不是先当审稿人。两步不加事务包裹，避免与 put/setSkillState 自带的事务嵌套。 */
  autoActivateSkill(id:string,version:number,ctx:ScopeContext){const r=this.get(id,ctx);if(r.kind!=='skill')fail('INVALID_SKILL');if(r.version!==version)fail('VERSION_CONFLICT');if(!r.evidenceIds.length||!this.currentSources(r,ctx))fail('SOURCE_UNAVAILABLE');const validated=r.status==='validated'?r:this.put({...r,version:r.version+1,status:'validated',review:'auto; sources verified in-session',updatedAt:new Date().toISOString()},ctx);return this.setSkillState(id,validated.version,'active',ctx);}
 catalog(ctx:ScopeContext){return this.list('skill',ctx).map(r=>this.active(r,ctx)).filter((r):r is WorkRecord=>Boolean(r)).map(r=>({id:r.id,name:r.name!,description:r.description!,version:r.version,scope:r.scope}));}
  rollbackSkill(id:string,expectedVersion:number,revision:number,ctx:ScopeContext){return this.store.transaction(()=>{const current=this.get(id,ctx);if(current.kind!=='skill')fail('INVALID_SKILL');if(current.version!==expectedVersion)fail('VERSION_CONFLICT');const target=revision===current.version?current:this.raw(id,revision);if(!target||target.kind!=='skill'||!['validated','active'].includes(target.status))fail('NOT_VALIDATED');if(!this.currentSources(target,ctx))fail('SOURCE_UNAVAILABLE');const version=current.version+1;return this.put({...target,version,status:'active',activeRevision:version,updatedAt:new Date().toISOString()},ctx);});}
  history(id:string,ctx:ScopeContext){const r=this.get(id,ctx);return[...this.store.db.prepare('SELECT body FROM work_revisions WHERE id=? ORDER BY version DESC').all(id).map((x:any)=>JSON.parse(x.body)),r];}
 loadSkill(name:string,ctx:ScopeContext){const r=this.list('skill',ctx).find(x=>x.name===name);const current=r&&this.active(r,ctx);if(!current)fail('SKILL_UNAVAILABLE');return current;}
 recordUse(input:{id:string;version:number;outcome:string;evidenceIds?:string[]},ctx:ScopeContext,{userApproved=false}={}){return this.store.transaction(()=>{const r=this.get(input.id,ctx);if(r.kind!=='skill')fail('INVALID_SKILL');if(input.version!==this.active(r,ctx)?.version)fail('SKILL_UNAVAILABLE');const refs=input.evidenceIds??[];for(const id of refs)this.source(id,ctx);const outcome=userApproved&&refs.length&&input.outcome==='success'?'user_confirmed_success':input.outcome==='failure'?'reported_failure':'reported';const use={id:randomUUID(),skillId:r.id,version:input.version,outcome,evidenceIds:refs,at:new Date().toISOString()};this.store.db.prepare('INSERT INTO work_uses VALUES (?,?,?,?)').run(use.id,r.id,input.version,JSON.stringify(use));// 阶段推进只看实际结果，不看有没有人工批准：批准只影响 use 记录的标签，不该拦住自动晋升。
  this.advance(r,input.outcome==='failure'?'reported_failure':input.outcome==='success'?'success':'reported',(ctx as any).sessionId,ctx);return use;});}
 /** 试用期推进：成功按"不同会话"计数，够门槛才转正；连续失败或被否定直接废弃。 */
 private advance(r:WorkRecord,outcome:string,session:string|undefined,ctx:ScopeContext){
   if(r.kind!=='skill'||r.stage==='deprecated')return r;
   try{
     const now=new Date().toISOString();
     if(outcome==='reported_failure'){
       const failures=(r.failures??0)+1;
       return this.put({...r,failures,updatedAt:now,...(failures>=VERIFY_THRESHOLD?{stage:'deprecated' as SkillStage,status:'disabled',activeRevision:undefined}:{})},ctx);
     }
     if(outcome==='reported')return r;
     const sessions=[...(r.verifiedSessions??[]),...(session?[session]:[])].filter((v,i,a)=>a.indexOf(v)===i).slice(-16);
     const promoted=sessions.length>=VERIFY_THRESHOLD;
     return this.put({...r,verifiedCount:sessions.length,verifiedSessions:sessions,failures:0,lastVerifiedAt:now,updatedAt:now,...(promoted?{stage:'verified' as SkillStage}:{})},ctx);
   }catch{this.store.metric('skill_advance_failed');return r;}
 }
 /** 人工裁决：一键转正或废弃，绕过计数门槛。 */
 setSkillStage(id:string,version:number,stage:SkillStage,ctx:ScopeContext){
   return this.store.transaction(()=>{
     const r=this.get(id,ctx);
     if(r.kind!=='skill')fail('INVALID_SKILL');
     if(r.version!==version)fail('VERSION_CONFLICT');
     if(!['candidate','verified','deprecated'].includes(stage))fail('INVALID_STAGE');
     return this.put({...r,version:r.version+1,stage,updatedAt:new Date().toISOString(),...(stage==='deprecated'?{status:'disabled',activeRevision:undefined}:{})},ctx);
   });
 }
 /** 轻量技能卡片：只给身份与阶段，正文永远不进上下文头部。 */
 cards(query:string,ctx:ScopeContext){
   const q=String(query??'').normalize('NFKC').toLowerCase().trim();
   return this.list('skill',ctx).filter(r=>r.status!=='disabled'&&r.stage!=='deprecated').filter(r=>!q||[r.name,r.description,r.title].filter(Boolean).join(' ').normalize('NFKC').toLowerCase().includes(q)).slice(0,8).map(r=>({id:r.id,name:r.name,description:r.description,version:r.version,activeRevision:r.activeRevision,stage:(r.stage??'candidate') as SkillStage,verifiedCount:r.verifiedCount??0,status:r.status,scope:r.scope,updatedAt:r.updatedAt}));
 }
 uses(id:string,ctx:ScopeContext){this.get(id,ctx);return this.store.db.prepare('SELECT body FROM work_uses WHERE skill_id=?').all(id).map((x:any)=>JSON.parse(x.body));}
 forget(id:string,ctx:ScopeContext){return this.store.transaction(()=>{this.get(id,ctx);purgeDerived(this.store.db,id);this.store.setting('writeEpoch',(this.store.setting('writeEpoch')??0)+1);return{deleted:true,id};});}
}
