import {createHash} from 'node:crypto';
                                                                     
import {sensitive,suspicious} from './safety.js';
                                             
                                                                                   
                                                                                        
const titles={about:'关于你',preferences:'交流与协作偏好',work:'近期工作'};
const trusted=new Set(['user_explicit','user_remember','user_confirmed','user_correction','tool_observation']);
function labelPattern(label       ){return new RegExp('(?<![A-Za-z0-9_])'+label.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'(?![A-Za-z0-9_])','gi');}
export function ignoredMemoryLabel(store            ,value       ){return (store.setting('ignoredMemoryLabels')??[]).some((s    )=>typeof s==='string'&&labelPattern(s).test(value));}
function neutralize(store            ,value       ){let out=value;for(const label of store.setting('ignoredMemoryLabels')??[])if(typeof label==='string')out=out.replace(labelPattern(label),'用户');return out;}
function sentence(content       ){return content.trim().replace(/^用户\s*的验收标准[:：]\s*/,'你希望').replace(/^用户\s*环境[:：]\s*/,'你使用').replace(/^用户\s*要\s*/,'你希望').replace(/^用户\s*讨厌\s*/,'你不喜欢').replace(/^用户\s*反感\s*/,'你不喜欢').replace(/^用户\s*/,'你').replace(/^(?:我|本人)/,'你').replace(/他自己/g,'你自己').replace(/他一个用户/g,'你一个用户').replace(/[。；;\s]+$/,'');}
function classify(r             )           {if(r.scope!=='global'||['project','recent','experience'].includes(r.category??''))return 'work';if(['preference','constraint'].includes(r.category??'')||/喜欢|习惯|希望|讨厌|反感|要求|验收|拍板|汇报|界面|承诺/.test(r.content))return 'preferences';return 'about';}
export function summarySources(store            ,ctx             ={})                {
 const now=Date.now(),history=store.setting('personalization')?.referenceHistory!==false,seen=new Set        ();let bytes=0;
 // 显式陈述优先：原来 automatic 排最前，自动条目一多就把用户亲口说的挤进截断区
 const rank                      ={user_explicit:0,user_remember:0,user_confirmed:0,user_correction:0,tool_observation:1,assistant_suggestion:2,inferred:2,external:2,unknown:2};
 return store.dump().filter(r=>r.status==='active'&&trusted.has(r.sourceType??'')&&(!r.expiresAt||Date.parse(r.expiresAt)>now)&&(!r.reviewAt||Date.parse(r.reviewAt)>now)&&(r.scope==='global'?r.content.length<=180:r.content.length<=300)&&!sensitive(r.content)&&!suspicious(r.content)&&(r.scope==='global'?['profile','preference','constraint'].includes(r.category??''):history&&r.scopeId===ctx[r.scope                         ])).sort((a,b)=>(rank[a.sourceType??'unknown']??2)-(rank[b.sourceType??'unknown']??2)||b.updatedAt.localeCompare(a.updatedAt)).flatMap(r=>{const content=neutralize(store,r.content),normal=sentence(content).replace(/[\s，。；、,.!！]/g,'');const cost=Buffer.byteLength(content);if(seen.has(normal)||bytes+cost>16384)return [];seen.add(normal);bytes+=cost;return[{id:r.id,version:r.version,content,key:classify(r)}];}).slice(0,64);
}
function signature(sources                ){return createHash('sha256').update(JSON.stringify(sources)).digest('hex');}
function cacheKey(ctx             ){return 'memorySummary:'+(ctx.project??ctx.workspace??'global');}
function validateSections(store            ,items    ,sources                )                      {
 if(!Array.isArray(items)||items.length<1||items.length>3)return null;const seen=new Set        (),out                 =[];
 for(const x of items){if(!x||!Object.hasOwn(titles,x.key)||seen.has(x.key)||typeof x.text!=='string'||!x.text.trim()||x.text.length>1200||sensitive(x.text)||suspicious(x.text)||ignoredMemoryLabel(store,x.text)||!Array.isArray(x.sourceIds)||!x.sourceIds.length||x.sourceIds.length>32)return null;const ids=[...new Set(x.sourceIds)]            ;if(ids.some(id=>!sources.some(s=>s.id===id&&s.key===x.key)))return null;seen.add(x.key);out.push({key:x.key,title:titles[x.key              ],text:x.text.trim(),sourceIds:ids});}
 return out;
}
export function saveSemanticSummary(store            ,ctx             ,items    ,snapshot                ){
 return store.transaction(()=>{const current=summarySources(store,ctx);if(signature(current)!==signature(snapshot))return false;const sections=validateSections(store,items,current);if(!sections)return false;store.setting(cacheKey(ctx),{sourceHash:signature(current),sections,updatedAt:new Date().toISOString()});return true;});
}
export function buildMemorySummary(store            ,ctx             ={}){
 const sources=summarySources(store,ctx),cache=store.setting(cacheKey(ctx));const sections=cache?.sourceHash===signature(sources)?validateSections(store,cache.sections,sources):null;
 if(sections)return {mode:'model',sections,sourceCount:sources.length,updatedAt:cache.updatedAt,fullCoverage:false};
 // 不按条数截断：丢一条硬偏好等于丢一条约束。原先 slice(0,3) 让每次新写入都挤掉一条旧的，
 // 实测 30 条 A 级偏好压 5 轮后只剩 1 条。改成按字符预算装，装得下就全装。
 const SECTION_MAX=1200;
 const local                 =[];for(const key of ['about','preferences','work']                ){const selected=sources.filter(r=>r.key===key);let text='',ids         =[];for(const r of selected){const value=sentence(r.content);const next=text?text+'；'+value:value;if(next.length>SECTION_MAX)break;text=next;ids.push(r.id);}if(text)local.push({key,title:titles[key],text:text+'。',sourceIds:ids});}
 return {mode:'local',sections:local,sourceCount:sources.length,updatedAt:null,fullCoverage:false};
}
/** Explicit local-admin correction. Back up before invoking against production. */
export function cleanMemoryLabel(store            ,label       ){
 if(typeof label!=='string'||!/^[A-Za-z][A-Za-z0-9_-]{0,30}$/.test(label))throw Error('INVALID_LABEL');
 return store.transaction(()=>{let records=0,revisions=0,workBodies=0;const pattern=()=>labelPattern(label);
  for(const r of store.dump()){const content=r.content.replace(pattern(),'用户');if(content===r.content)continue;store.db.prepare('INSERT OR IGNORE INTO revisions VALUES (?,?,?)').run(r.id,r.version,JSON.stringify({...r,content}));const next={...r,content,version:r.version+1,updatedAt:new Date().toISOString(),status:r.sourceType==='inferred'&&r.status==='active'?'pending':r.status};store.db.prepare('UPDATE records SET body=? WHERE id=?').run(JSON.stringify(next),r.id);records++;}
  for(const row of store.db.prepare('SELECT id,version,body FROM revisions').all()         ){const r=JSON.parse(row.body);if(typeof r.content!=='string')continue;const content=r.content.replace(pattern(),'用户');if(content!==r.content){store.db.prepare('UPDATE revisions SET body=? WHERE id=? AND version=?').run(JSON.stringify({...r,content}),row.id,row.version);revisions++;}}
  for(const table of ['work_objects','work_revisions'])for(const row of store.db.prepare('SELECT rowid,body FROM '+table).all()         ){const r=JSON.parse(row.body);let changed=false;for(const key of ['title','description','body'])if(typeof r[key]==='string'){const value=r[key].replace(pattern(),'用户');if(value!==r[key]){r[key]=value;changed=true;}}if(changed){store.db.prepare('UPDATE '+table+' SET body=? WHERE rowid=?').run(JSON.stringify(r),row.rowid);workBodies++;}}
  store.reindex();store.db.exec("DELETE FROM settings WHERE key LIKE 'memorySummary:%'");const labels=store.setting('ignoredMemoryLabels')??[];store.setting('ignoredMemoryLabels',[...new Set([...labels,label])]);return {records,revisions,workBodies};
 });
}

