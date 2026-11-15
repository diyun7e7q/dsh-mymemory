import {buildMemorySummary,summarySources} from './summary.ts';
import {memoryPreferences,memoryProfileRecords} from './personalization.ts';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {mkdirSync,writeFileSync,readdirSync,readFileSync,statSync} from 'node:fs';
import {join} from 'node:path';
import {loadSoul,SOUL_FILENAME,SOUL_LIMIT} from './soul.ts';
import {loadDoc,saveDoc,STATE_LIMIT,type DocKind} from './docs.ts';
import {scopeContext} from './core.ts';
import {WorkStore} from './work.ts';
import {fail,safeError} from './safety.ts';
import {stageMigration,cleanupPrevious} from './migration.ts';
import {readPointerFile} from './location.ts';
const CATEGORIES=['profile','preference','constraint','project','episode','experience','recent'];
interface PanelDeps{store:any;work?:WorkStore;skillAdapter?:{available:boolean;changed:()=>void};dataDir:string;home:string;profile?:string;soulDir:string;soul:any;getCwd?:()=>string|undefined;authorize?:(req:any)=>boolean;onSoulSaved?:(text:string)=>void;onDistill?:()=>Promise<any>;onDistillApply?:(text:string)=>any;}
function send(res:any,status:number,body:any){res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(JSON.stringify(body));}
function readJson(req:any):Promise<any>{return new Promise((resolve,reject)=>{let size=0;const chunks:Buffer[]=[];req.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>65536){reject(new Error('BODY_TOO_LARGE'));req.destroy();return;}chunks.push(chunk);});req.on('end',()=>{try{resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}'));}catch{reject(new Error('INVALID_JSON'));}});req.on('error',reject);});}
function trustedBrowser(req:any){
 const remote=String(req.socket?.remoteAddress??'');if(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(remote))return false;
 if(req.headers['x-mymemory-client']!=='1'||!String(req.headers['content-type']??'').startsWith('application/json'))return false;
 const host=String(req.headers.host??'');try{if(!['localhost','127.0.0.1','[::1]'].includes(new URL('http://'+host).hostname))return false;}catch{return false;}
 const origin=req.headers.origin;
 if(typeof origin==='string'&&origin!=='null'){try{const url=new URL(origin);return(['http:','https:'].includes(url.protocol)&&url.host===host)||['app:','dsh:'].includes(url.protocol);}catch{return false;}}
 return origin===undefined||req.headers['sec-fetch-site']==='same-origin'||req.headers['sec-fetch-site']==='none';
}
const TRUSTED_SOURCES=['user_explicit','user_remember','user_confirmed','user_correction'];
/** A/B/C/D 分层只做展示统计：A 是可信核心画像，D 是已失效的历史，口径与 summary 的取舍保持一致。 */
function storeGrade(deps:PanelDeps,ctx:any){
 const records=deps.store?.dump()??[];const grades:Record<string,number>={A:0,B:0,C:0,D:0};
 for(const r of records){const g=r.status==='superseded'||r.invalidAt?'D':r.status==='pending'?'C':(r.scope==='global'&&['profile','preference','constraint'].includes(r.category??'')&&TRUSTED_SOURCES.includes(r.sourceType??''))?'A':'B';grades[g]++;}
 let gate=0,spills=0;
 try{for(const row of deps.store.db.prepare("SELECT key,SUM(value) AS v FROM metrics GROUP BY key").all() as any[])if(String(row.key).startsWith('gate_'))gate+=Number(row.v??0);}catch{}
 try{spills=readdirSync(join(deps.dataDir,'spill')).filter((n:string)=>n.endsWith('.txt')).length;}catch{}
 return{grades,records:records.length,gateInterceptions:gate,spills,cacheHitRate:null};
}
function snapshotList(deps:PanelDeps){
 const dir=join(deps.dataDir,'forget');
 try{return readdirSync(dir).filter((n:string)=>n.endsWith('.json')).map((n:string)=>{const s=statSync(join(dir,n));return{name:n,bytes:s.size,at:s.mtime.toISOString()};}).sort((a:any,b:any)=>b.at.localeCompare(a.at)).slice(0,50);}catch{return[];}
}
function snapshotRead(deps:PanelDeps,name:string){
 if(!/^[A-Za-z0-9._-]+\.json$/.test(name))fail('INVALID_SNAPSHOT');
 const raw=JSON.parse(readFileSync(join(deps.dataDir,'forget',name),'utf8'));delete raw.history;return raw;
}
export function createPanelHandler(deps:PanelDeps){
 const token=randomBytes(32).toString('hex');
 // 人设文件的字数上限跟注入预算同源：面板允许写多长，系统提示里就允许带多长。
 const docLimits=()=>({user:deps.store?.budgets().profileBudgetChars??4096,state:STATE_LIMIT});const work=deps.work??(deps.store?new WorkStore(deps.store):undefined);
 function view(body:any){const cwd=typeof body?.cwd==='string'&&body.cwd?body.cwd:deps.getCwd?.();const ctx=scopeContext(cwd);const manageAll=body?.manageAll===true;
 let records=(deps.store?.dump()??[]).filter((r:any)=>r.status!=='superseded'&&(manageAll||r.scope==='global'||r.scopeId===ctx[r.scope as 'workspace'|'project']));
 const offset=body?.offset??0;if(!Number.isInteger(offset)||offset<0)fail('INVALID_OFFSET');if(typeof body?.query==='string'&&body.query.trim())records=deps.store.search(body.query.trim(),ctx,{limit:20,includePending:true});
 const soul=loadSoul(deps.soulDir),pointer=readPointerFile(deps.home,deps.profile??'desktop');
 return{ctx,data:{memorySummary:deps.store?buildMemorySummary(deps.store,ctx):{sections:[],mode:'local',sourceCount:0},summarySources:deps.store?summarySources(deps.store,ctx).map(source=>deps.store.get(source.id,ctx)):[],personalization:deps.store?memoryPreferences(deps.store):{enabled:false,referenceHistory:false,automaticLearning:false},profile:deps.store?memoryProfileRecords(deps.store).map((r:any)=>r.content):[],project:{cwd:ctx.project?cwd:null,verified:Boolean(ctx.project),selection:body?.cwd?'user_selected':'latest_observed_session'},manageAll,dataDir:deps.dataDir,previous:pointer.previous,restartRequired:Boolean(deps.store?.setting('maintenance')),soul:{...soul,limit:SOUL_LIMIT},docs:{user:loadDoc(deps.soulDir,'user',docLimits().user),state:loadDoc(deps.soulDir,'state',docLimits().state)},records:records.slice(offset,offset+30),nextOffset:offset+30<records.length?offset+30:null,categories:CATEGORIES,handoffs:work?.list('handoff',ctx)??[],skills:work?.list('skill',ctx).map(r=>({...r,uses:work.uses(r.id,ctx),history:work.history(r.id,ctx).map(({body,...v})=>v)}))??[],stats:deps.store?.stats(ctx)??{unavailable:true},conflicts:deps.store?deps.store.conflicts():[],ledger:storeGrade(deps,ctx),snapshots:snapshotList(deps),skillCards:work?work.cards('',ctx):[],skillAdapter:deps.skillAdapter?.available?'available':'unavailable'}};
 }
 return async(req:any,res:any)=>{
  if(req.method!=='POST'){send(res,405,{ok:false,error:'POST_ONLY'});return;}
  if(!deps.authorize?.(req)){send(res,401,{ok:false,error:'OWNER_SESSION_REQUIRED'});return;}
  if(!trustedBrowser(req)){send(res,403,{ok:false,error:'FORBIDDEN'});return;}
  try{
   const body=await readJson(req);if(!body||typeof body!=='object'||Array.isArray(body))fail('INVALID_ARGUMENT');
   if(body.op==='bootstrap'){send(res,200,{ok:true,data:{token}});return;}
   const supplied=req.headers['x-mymemory-token'];if(typeof supplied!=='string'||supplied.length!==token.length||!timingSafeEqual(Buffer.from(supplied),Buffer.from(token))){send(res,403,{ok:false,error:'SESSION_REQUIRED'});return;}
   const {ctx}=view(body),store=deps.store;const op=String(body.op??'read');let extra:any={};
   if(op!=='read'&&!store)fail('STORE_UNAVAILABLE');if(op!=='read'&&op!=='move')store.assertWritable();
   switch(op){
    case 'read':break;
    case 'memory_settings':{const old=memoryPreferences(store);for(const k of ['enabled','referenceHistory','automaticLearning'] as const)if(body[k]!==undefined){if(typeof body[k]!=='boolean')fail('INVALID_ARGUMENT');old[k]=body[k];}store.setting('personalization',old);break;}
    case 'clear_memories':{if(body.confirm!=='all-memory')fail('CONFIRMATION_REQUIRED');store.transaction(()=>{for(const r of store.dump())store.remove(r.id);});break;}
    case 'distill':extra=await deps.onDistill?.()??{updated:false};break;
    case 'distill_apply':extra=await deps.onDistillApply?.(String(body.text??''))??{updated:false};break;
    case 'doc':{
     const kind=String(body.kind??'');if(kind!=='user'&&kind!=='state')fail('INVALID_DOC');
     const limits=docLimits();saveDoc(deps.soulDir,kind as DocKind,String(body.text??''),limits[kind as 'user'|'state']);
     break;
    }
     case 'soul':{if(typeof body.text!=='string')fail('INVALID_SOUL');const next=body.text.replace(/\r\n/g,'\n');if(next.length>SOUL_LIMIT||Buffer.byteLength(next)>4096)fail('SOUL_BUDGET_EXCEEDED');mkdirSync(deps.soulDir,{recursive:true});writeFileSync(join(deps.soulDir,SOUL_FILENAME),next,'utf8');deps.onSoulSaved?.(next.trim());break;}
    case 'new':{if(!String(body.content??'').trim())fail('EMPTY_CONTENT');store.add({content:body.content,category:body.category??'profile',scope:body.scope??(ctx.project?'project':'global'),sourceType:'user_explicit'},ctx);break;}
    case 'edit':{store.get(body.id,ctx);store.retext(body.id,String(body.content??''),body.expectedVersion);break;}
    case 'approve':store.approve(body.id,body.expectedVersion,ctx);break;
    case 'forget':store.forget(body.id,ctx);break;
    case 'auto':if(!['off','candidates','conservative'].includes(body.mode))fail('INVALID_MODE');store.setting('autoMode',body.mode);break;
    case 'handoff_save':work!.saveHandoff(body,ctx);break;
    case 'skill_propose':work!.proposeSkill(body,ctx);break;
    case 'skill_validate':work!.validateSkill(body.id,body.expectedVersion,ctx,{userApproved:true});break;
    case 'skill_enable':work!.setSkillState(body.id,body.expectedVersion,'active',ctx);break;
    case 'skill_disable':work!.setSkillState(body.id,body.expectedVersion,'disabled',ctx);break;
    case 'skill_rollback':work!.rollbackSkill(body.id,body.expectedVersion,body.revision,ctx);break;
    case 'skill_feedback':work!.recordUse({id:body.id,version:body.expectedVersion,outcome:body.outcome,evidenceIds:body.evidenceIds},ctx,{userApproved:true});break;
    case 'work_forget':work!.forget(body.id,ctx);break;
    case 'resolve_conflict':extra=store!.resolveConflict(String(body.id??''),Boolean(body.accept),ctx);break;
    case 'skill_stage':extra=work!.setSkillStage(String(body.id??''),Number(body.expectedVersion),body.stage,ctx);break;
    case 'snapshot_read':extra={snapshot:snapshotRead(deps,String(body.name??''))};break;
    case 'snapshot_restore':extra={restored:store!.add({...snapshotRead(deps,String(body.name??'')),status:undefined} as any,ctx)};break;
    case 'move':extra=await stageMigration(store,deps,String(body.dir??''));break;
    case 'cleanup':extra=cleanupPrevious(store,deps);break;
    default:fail('INVALID_OP');
   }
   deps.skillAdapter?.changed();send(res,200,{ok:true,data:{...view(body).data,...extra}});
  }catch(error){send(res,400,{ok:false,error:safeError(error)});}
 };
}
export function mountPanel(ctx:any,deps:PanelDeps){try{ctx.inject?.(['webServer','connection'],(host:any)=>{try{const handler=createPanelHandler({...deps,authorize:(req:any)=>{const admission=host.connection.admit(req);return !('rejection' in admission)&&admission.peer===host.connection.browserPeer;}});host.effect(()=>host.webServer.register({kind:'exact',path:'/mymemory/api',handler}));}catch{}});}catch{}}
