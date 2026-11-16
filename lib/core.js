import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,realpathSync,existsSync} from 'node:fs';
import {dirname,resolve,join,parse} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {fail,text,sensitive,suspicious,uncertain} from './safety.js';
import {terms,matches} from './retrieval.js';
import {validateBudgets} from './config.js';
import {initWork,purgeDerived} from './work.js';
import {readPointerFile,pathsEqual} from './location.js';

                                                                               
                                                                                                                                                                                                                                          
// invalidAt/supersededBy/supersedes 构成双时态：valid 看业务时间，created/updated 看记录时间。
// 事实改主意时旧记录退场但不消失，检索默认只给 active，历史链靠 supersededBy 走。
                                                                                                                                                                                                                                                                      
const categories=['profile','preference','constraint','recent','project','episode','experience'];
const sources=['user_explicit','user_remember','user_correction','assistant_suggestion','user_confirmed','inferred','external','unknown','tool_observation'];
const trusted=['user_explicit','user_remember','user_correction','user_confirmed','tool_observation'];
// 模型推断、建议、外部材料不能自动成为用户事实。
const promotable=trusted;
function hash(p       ){return createHash('sha256').update(p).digest('hex');}
export function scopeContext(cwd        ,sessionId        )              {
  if(!cwd)return {sessionId};
  let path       ;try{path=realpathSync(resolve(cwd));}catch{return {sessionId};}
  if(process.platform==='win32')path=path.toLowerCase();
  let root=path;
  for(let p=path;;p=dirname(p)){if(existsSync(join(p,'.git'))){root=p;break;}if(p===parse(p).root)break;}
  return {workspace:hash(path),project:hash(root),sessionId};
}
function scopeId(scope       ,ctx             ){if(scope==='global')return 'global';const id=ctx[scope                         ];if(!id)fail('SCOPE_UNAVAILABLE');return id;}
function valid(input            ){
  const content=text(input.content);if(sensitive(content))fail('SENSITIVE_CONTENT_REJECTED');
  const category=input.category??'project',scope=input.scope??'project',sourceType=input.sourceType??'unknown';
  if(!categories.includes(category)||!['global','workspace','project'].includes(scope)||!sources.includes(sourceType))fail('INVALID_ENUM');
  if(input.factKey!==undefined&&!/^[a-z0-9_.:-]{1,100}$/i.test(input.factKey))fail('INVALID_FACT_KEY');
  for(const v of [input.expiresAt,input.reviewAt])if(v!==undefined&&(typeof v!=='string'||!Number.isFinite(Date.parse(v))))fail('INVALID_TIME');
  const sourceRef                         ={};
  for(const k of ['sessionId','messageId']         )if(input.sourceRef?.[k]!==undefined)sourceRef[k]=text(input.sourceRef[k],200);
  if(input.origin!==undefined&&!['automatic','saved'].includes(input.origin))fail('INVALID_ENUM');return {content,category,scope,sourceType,sourceRef,factKey:input.factKey,expiresAt:input.expiresAt,reviewAt:input.reviewAt,...(input.origin?{origin:input.origin}:{})};
}
export class MemoryStore {
  db              ; closed=false;         depth=0;
  constructor(file       ){
    mkdirSync(dirname(file),{recursive:true,mode:0o700});
    this.db=new DatabaseSync(file);this.db.exec('PRAGMA busy_timeout=3000; PRAGMA journal_mode=WAL; PRAGMA secure_delete=ON; PRAGMA foreign_keys=ON;');
    const v=(this.db.prepare('PRAGMA user_version').get()       ).user_version;
    if(v>3){this.close();fail('UNSUPPORTED_SCHEMA');}
    try{this.recoverInterruptedMigration();this.assertWritable();}catch(error){this.close();throw error;}
    this.transaction(()=>{this.db.exec(`CREATE TABLE IF NOT EXISTS records(id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS revisions(id TEXT NOT NULL, version INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(id,version));
      CREATE TABLE IF NOT EXISTS terms(id TEXT NOT NULL, term TEXT NOT NULL, PRIMARY KEY(id,term));
      CREATE INDEX IF NOT EXISTS terms_lookup ON terms(term);
      CREATE TABLE IF NOT EXISTS tombstones(id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS metrics(day TEXT NOT NULL, key TEXT NOT NULL, value REAL NOT NULL, PRIMARY KEY(day,key));
      CREATE TABLE IF NOT EXISTS conflicts(id TEXT PRIMARY KEY, body TEXT NOT NULL);
      PRAGMA user_version=3;`);
    initWork(this.db);
    if(v<2){for(const r of this.all()){if(r.status==='active'&&(r.sourceType==='inferred'||r.evidence==='unconfirmed')){this.db.prepare('INSERT OR REPLACE INTO revisions VALUES (?,?,?)').run(r.id,r.version,JSON.stringify(r));this.put({...r,status:'pending',version:r.version+1,updatedAt:new Date().toISOString()});}}}
    });
    // 检索分词规则一变，旧索引就与新规则不匹配（子词没进库，搜 injector 命中不了 dsh-super-injector），
    // 所以每次改 words()/matches() 都要升这个版本号，让已有库在打开时自动重建。
    if(this.setting('indexVersion')!==3){this.reindex();this.setting('indexVersion',3);}
    const migration=this.setting('maintenance');if(migration&&this.sameDataDir(migration.target))this.releaseMaintenance(migration.id,true);
  }
          sameDataDir(target       ){try{return pathsEqual(dirname(realpathSync(this.db.location() )),realpathSync(target));}catch{return false;}}
          migrationMarker(){if(!this.db.prepare("SELECT name FROM sqlite_master WHERE name='settings'").get())return undefined;const row=this.db.prepare("SELECT body FROM settings WHERE key='maintenance'").get()       ;return row&&JSON.parse(row.body);}
          migrationCommitted(marker    ){if(typeof marker.home!=='string')return false;const pointer=readPointerFile(marker.home,marker.profile??'desktop');return pointer.migrationId===marker.id&&pathsEqual(resolve(pointer.dataDir),resolve(marker.target))&&pointer.previous!==undefined&&pathsEqual(resolve(pointer.previous),resolve(marker.source));}
          recoverInterruptedMigration(){
    const marker=this.migrationMarker();
    if(!marker||marker.phase!=='preparing'||!this.sameDataDir(marker.source)||this.migrationCommitted(marker))return;
    if(!Number.isInteger(marker.ownerPid)||marker.ownerPid<=0)return;
    try{process.kill(marker.ownerPid,0);return;}catch(error    ){if(error.code!=='ESRCH')return;}
    const candidate=join(marker.target,'memory.sqlite');
    if(existsSync(candidate)){
      let db                       ;
      try{db=new DatabaseSync(candidate,{readOnly:true});const row=db.prepare("SELECT body FROM settings WHERE key='completedMigration'").get()       ;if(row&&JSON.parse(row.body).id===marker.id)return;}
      catch{/* An incomplete, uncommitted backup has no authority. Preserve it for inspection. */}
      finally{db?.close();}
    }
    this.releaseMaintenance(marker.id);
  }
  assertWritable(){const marker=this.migrationMarker();if(marker&&!(this.sameDataDir(marker.target)&&this.migrationCommitted(marker)))fail('STORE_MIGRATING');}
  releaseMaintenance(id       ,completed=false){this.db.exec('BEGIN IMMEDIATE');try{const marker=this.migrationMarker();if(!marker||marker.id!==id)fail('MIGRATION_PROOF_REQUIRED');if(completed){if(!this.sameDataDir(marker.target)||!this.migrationCommitted(marker))fail('MIGRATION_PROOF_REQUIRED');this.db.prepare("INSERT OR REPLACE INTO settings VALUES ('completedMigration',?)").run(JSON.stringify(marker));}this.db.prepare("DELETE FROM settings WHERE key='maintenance'").run();this.db.exec('COMMIT');}catch(error){this.db.exec('ROLLBACK');throw error;}}
  transaction   (fn      )   {const level=this.depth;this.db.exec(level?`SAVEPOINT nested_${level}`:'BEGIN IMMEDIATE');this.depth++;try{if(level===0)this.assertWritable();const result=fn();this.db.exec(level?`RELEASE nested_${level}`:'COMMIT');return result;}catch(e){this.db.exec(level?`ROLLBACK TO nested_${level}; RELEASE nested_${level}`:'ROLLBACK');throw e;}finally{this.depth--;}}
  close(){if(!this.closed){this.db.close();this.closed=true;}}
          all()               {return this.db.prepare('SELECT body FROM records').all().map((r    )=>JSON.parse(r.body));}
          accessible(r             ,ctx             ){return r.scope==='global'||ctx[r.scope                         ]===r.scopeId;}
          put(r             ){this.db.prepare('INSERT OR REPLACE INTO records VALUES (?,?)').run(r.id,JSON.stringify(r));this.db.prepare('DELETE FROM terms WHERE id=?').run(r.id);const ins=this.db.prepare('INSERT OR IGNORE INTO terms VALUES (?,?)');for(const term of terms(r.content))ins.run(r.id,term);}
  add(input            ,ctx             )              {
    text(input.content,this.budgets().maxMemoryChars);
    const v=valid(input),sid=scopeId(v.scope,ctx);
    return this.transaction(()=>{
      const all=this.all();const duplicate=all.find(r=>r.scope===v.scope&&r.scopeId===sid&&r.content===v.content&&r.status!=='superseded');if(duplicate)return duplicate;
      if(all.length>=10000)fail('STORE_LIMIT');
      const conflict=v.factKey&&all.some(r=>r.scope===v.scope&&r.scopeId===sid&&r.factKey===v.factKey&&r.status==='active');
      // 落 pending 的理由：显式要求、来源不可提升、内容可疑、措辞不确定、与既有事实冲突。
      const status=input.status==='pending'||!promotable.includes(v.sourceType)||suspicious(v.content)||uncertain(v.content)||conflict?'pending':'active';
      const now=new Date().toISOString();
      const r             ={...v,id:randomUUID(),scopeId:sid,version:1,createdAt:now,updatedAt:now,status,evidence:v.sourceType==='tool_observation'?'tool_result':trusted.includes(v.sourceType)?'user_statement':'unconfirmed',sensitivity:'normal',relations:[]};
      this.put(r);return r;
    });
  }
  get(id       ,ctx             )              {
    text(id,100);const row=this.db.prepare('SELECT body FROM records WHERE id=?').get(id)       ;const r=row&&JSON.parse(row.body);if(!r||!this.accessible(r,ctx))fail('NOT_FOUND');return r;
  }
  list(ctx             ,{includePending=false,limit=100,offset=0}                                                       ={})               {
    return this.all().filter(r=>this.accessible(r,ctx)&&(r.status==='active'||(includePending&&r.status==='pending'))).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)).slice(offset,offset+Math.min(Math.max(limit,1),100));
  }
  search(query       ,ctx             ,{limit=8,category,includePending=false}                                                         ={})               {
    text(query,256);const start=performance.now();const ts=terms(query);if(!ts.length)return [];
    const ids=new Set(this.db.prepare(`SELECT DISTINCT id FROM terms WHERE term IN (${ts.map(()=>'?').join(',')})`).all(...ts).map((x    )=>x.id));
    const now=Date.now();const results=this.all().filter(r=>ids.has(r.id)&&this.accessible(r,ctx)&&(r.status==='active'||(includePending&&r.status==='pending'))&&(!r.expiresAt||Date.parse(r.expiresAt)>now)&&(!r.reviewAt||Date.parse(r.reviewAt)>now)&&(!category||r.category===category)&&matches(r.content,query));
    const rank=(r             )=>(r.scope==='project'?3:r.scope==='workspace'?2:1)+(['constraint','preference'].includes(r.category??'')?2:0)+(trusted.includes(r.sourceType??'')?1:0);
    results.sort((a,b)=>rank(b)-rank(a)||b.updatedAt.localeCompare(a.updatedAt));
    this.metric('search_calls');this.metric('search_ms',performance.now()-start);
    return results.slice(0,Math.min(Math.max(limit,1),this.budgets().maxResults));
  }
  update(id       ,change                                                                                                                                                   ,ctx             )              {
    if(['scope','scopeId','category','factKey'].some(key=>Object.hasOwn(change,key)))fail('IMMUTABLE_SCOPE');
    text(change.content,this.budgets().maxMemoryChars);
    return this.transaction(()=>{const old=this.get(id,ctx);if(change.expectedVersion!==old.version)fail('VERSION_CONFLICT');
      const v=valid({...old,...change});const now=new Date().toISOString();
      const conflict=old.factKey&&this.all().some(r=>r.id!==id&&r.scope===old.scope&&r.scopeId===old.scopeId&&r.factKey===old.factKey&&r.status==='active');
      const active=trusted.includes(v.sourceType)&&!suspicious(v.content)&&!uncertain(v.content)&&!conflict;
      if(!active){const candidate=this.add({...v,status:'pending'},ctx);if(candidate.id===id)return old;candidate.relations=[...new Set([...candidate.relations,id])];this.put(candidate);return candidate;}
      const fresh             ={...old,...v,version:old.version+1,updatedAt:now,status:active?'active':'pending',evidence:v.sourceType==='tool_observation'?'tool_result':trusted.includes(v.sourceType)?'user_statement':'unconfirmed'};
      this.db.prepare('INSERT INTO revisions VALUES (?,?,?)').run(id,old.version,JSON.stringify(old));this.put(fresh);if(v.sourceRef?.sessionId&&v.sourceRef?.messageId!==undefined){for(const pending of this.all()){if(pending.id!==id&&pending.status==='pending'&&pending.content===fresh.content&&pending.scope===fresh.scope&&pending.scopeId===fresh.scopeId&&pending.sourceRef?.sessionId===v.sourceRef.sessionId&&pending.sourceRef?.messageId===v.sourceRef.messageId){this.db.prepare('INSERT OR IGNORE INTO revisions VALUES (?,?,?)').run(pending.id,pending.version,JSON.stringify(pending));this.put({...pending,status:'superseded',version:pending.version+1,relations:[...new Set([...pending.relations,id])]});}}}return fresh;});
  }
  history(id       ,ctx             ){this.get(id,ctx);return this.db.prepare('SELECT body FROM revisions WHERE id=? ORDER BY version').all(id).map((r    )=>JSON.parse(r.body));}
  /** 已认证本地管理入口；仍检查敏感内容和版本。 */
  retext(id       ,content       ,expectedVersion       )              {
    text(content,this.budgets().maxMemoryChars);
    return this.transaction(()=>{const old=this.all().find(r=>r.id===id);if(!old)fail('NOT_FOUND');
      valid({...old,content});
      if(expectedVersion!==old.version)fail('VERSION_CONFLICT');
      if(suspicious(content))fail('UNSAFE_CONTENT');
      const fresh             ={...old,content,version:old.version+1,updatedAt:new Date().toISOString(),status:'active',sourceType:'user_correction',evidence:'user_edited'};
      this.db.prepare('INSERT INTO revisions VALUES (?,?,?)').run(id,old.version,JSON.stringify(old));this.put(fresh);this.bumpEpoch();return fresh;});
  }
  approve(id       ,expectedVersion       ,ctx             ){const old=this.get(id,ctx);return this.update(id,{content:old.content,expectedVersion,sourceType:'user_confirmed'},ctx);}
  forget(id       ,ctx             ){this.transaction(()=>{this.get(id,ctx);purgeDerived(this.db,id);for(const table of ['records','terms','revisions'])this.db.prepare(`DELETE FROM ${table} WHERE id=?`).run(id);this.db.prepare('INSERT OR IGNORE INTO tombstones VALUES (?)').run(id);this.bumpEpoch();});
    try{this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');}catch{}return {deleted:true,id,uncontrolledCopies:['DSH session logs','manual exports','system backups','model services']};}
  reindex(){this.transaction(()=>{this.db.exec('DELETE FROM terms');for(const r of this.all())this.put(r);});return {rebuilt:true};}
  /** 设置页用：不做 scope 过滤，本地管理员视角要看全部条目。 */
  dump()               {return this.all().sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));}
  /** 设置页用：同上，删除不看 scope。forget 那条路要 ctx 鉴权，面板拿不到会话。 */
  remove(id       ){text(id,100);this.transaction(()=>{purgeDerived(this.db,id);for(const table of ['records','terms','revisions'])this.db.prepare(`DELETE FROM ${table} WHERE id=?`).run(id);this.db.prepare('INSERT OR IGNORE INTO tombstones VALUES (?)').run(id);this.bumpEpoch();});}
  /**
   * 重复命中只刷新访问时间。
   * 不能碰 updatedAt：摘要按它排序，一次重复写入就会把旧事实顶到最新位置。
   */
  touch(id       ){
    this.transaction(()=>{const row=this.db.prepare('SELECT body FROM records WHERE id=?').get(id)       ;if(!row)return;const r=JSON.parse(row.body);this.put({...r,lastAccessAt:new Date().toISOString()});});
    this.metric('record_touch');
  }
  /**
   * 近重复合并只追加来源引用，不动正文。
   * 内容不同就是不同事实，那是 supersede 的职责；把两条不同结论合成一条，等于造事实。
   */
  mergeSource(id       ,sourceRef                          ){
    if(!sourceRef||(sourceRef.sessionId===undefined&&sourceRef.messageId===undefined))return;
    const tag='src:'+[sourceRef.sessionId??'',sourceRef.messageId??''].join(':');
    this.transaction(()=>{const row=this.db.prepare('SELECT body FROM records WHERE id=?').get(id)       ;if(!row)return;const r=JSON.parse(row.body);if(r.relations.includes(tag))return;this.put({...r,relations:[...r.relations,tag].slice(-24)});});
    this.metric('merged_source');
  }
  /**
   * 软失效取代：旧记录留指针退场，新记录接上反向链。
   * 不走 add()：它按「同 scope 同 content 非 superseded」查重、按 factKey 判冲突落 pending，
   * 而这里的语义就是顶掉既有事实，查重和冲突都是预期行为，不能被它们拦下。
   */
  supersede(id       ,change                                                                        ,ctx             )              {
    text(change.content,this.budgets().maxMemoryChars);
    return this.transaction(()=>{
      const old=this.get(id,ctx);
      if(old.status!=='active')fail('VERSION_CONFLICT');
      const v=valid({...old,content:change.content,sourceType:change.sourceType??old.sourceType});
      const now=new Date().toISOString();
      const fresh             ={...v,id:randomUUID(),scopeId:old.scopeId,version:1,createdAt:now,updatedAt:now,status:'active',evidence:v.sourceType==='tool_observation'?'tool_result':trusted.includes(v.sourceType)?'user_statement':'unconfirmed',sensitivity:old.sensitivity,relations:[],supersedes:old.id,...(old.origin?{origin:old.origin}:{})};
      const retired             ={...old,status:'superseded',version:old.version+1,updatedAt:now,invalidAt:now,supersededBy:fresh.id};
      this.db.prepare('INSERT OR REPLACE INTO revisions VALUES (?,?,?)').run(id,old.version,JSON.stringify(old));
      this.put(retired);this.put(fresh);
      this.metric('superseded');
      return fresh;
    });
  }
  /** 三级网关的收件箱。A 级事实只能由人裁决，模型提议到此为止。 */
  raiseConflict(input                                                                                    )        {
    const id=randomUUID(),now=new Date().toISOString();
    const body=JSON.stringify({id,targetId:text(input.targetId,100),proposal:text(input.proposal,2000),reason:text(input.reason,80),sourceRef:input.sourceRef??{},status:'open',createdAt:now});
    this.transaction(()=>{this.db.prepare('INSERT OR REPLACE INTO conflicts VALUES (?,?)').run(id,body);this.metric('conflict_raised');});
    return id;
  }
  conflicts(includeResolved=false){
    return this.db.prepare('SELECT body FROM conflicts').all().map((r    )=>JSON.parse(r.body)).filter((c    )=>includeResolved||c.status==='open').sort((a    ,b    )=>b.createdAt.localeCompare(a.createdAt));
  }
  resolveConflict(id       ,accept        ,ctx             ){
    return this.transaction(()=>{
      const row=this.db.prepare('SELECT body FROM conflicts WHERE id=?').get(id)       ;if(!row)fail('NOT_FOUND');
      const c=JSON.parse(row.body);if(c.status!=='open')fail('VERSION_CONFLICT');
      const record=accept?this.supersede(c.targetId,{content:c.proposal,sourceType:'user_confirmed',sourceRef:c.sourceRef},ctx):undefined;
      const next={...c,status:accept?'accepted':'rejected',resolvedAt:new Date().toISOString()};
      this.db.prepare('INSERT OR REPLACE INTO conflicts VALUES (?,?)').run(id,JSON.stringify(next));
      this.metric(accept?'conflict_accepted':'conflict_rejected');
      return {conflict:next,record};
    });
  }
  export(ctx             ){return {schemaVersion:1,exportedAt:new Date().toISOString(),records:this.all().filter(r=>this.accessible(r,ctx))};}
  import(data    ,ctx             ){
    if(Buffer.byteLength(JSON.stringify(data))>100_000_000)fail('IMPORT_TOO_LARGE');
    if(data?.schemaVersion!==1||!Array.isArray(data.records)||data.records.length>10000)fail('INVALID_SCHEMA');
    const validated=data.records.map((r    )=>{valid(r);if(typeof r.id!=='string'||!/^[0-9a-f-]{36}$/.test(r.id))fail('INVALID_ID');if(r.scopeId!==scopeId(r.scope,ctx))fail('IMPORT_SCOPE_MISMATCH');return r;});
    return this.transaction(()=>{let imported=0,skipped=0;for(const r of validated){if(this.db.prepare('SELECT id FROM tombstones WHERE id=?').get(r.id)||this.db.prepare('SELECT id FROM records WHERE id=?').get(r.id)){skipped++;continue;}
      if(this.all().length>=10000)fail('STORE_LIMIT');const v=valid(r);const now=new Date().toISOString();this.put({...v,id:r.id,scopeId:scopeId(v.scope,ctx),version:1,createdAt:now,updatedAt:now,status:'pending',evidence:'import_unconfirmed',sensitivity:'normal',relations:[]});imported++;}return {imported,skipped};});
  }
          bumpEpoch(){this.db.exec("DELETE FROM settings WHERE key LIKE 'memorySummary:%'");this.db.prepare("INSERT INTO settings VALUES ('writeEpoch','1') ON CONFLICT(key) DO UPDATE SET body=CAST(CAST(body AS INTEGER)+1 AS TEXT)").run();}
  setting(key       ,value         )    {if(value!==undefined)this.transaction(()=>{this.db.prepare('INSERT OR REPLACE INTO settings VALUES (?,?)').run(key,JSON.stringify(value));if((['autoMode','model','budgets','personalization','ignoredMemoryLabels'].includes(key)||key.startsWith('temporary:')))this.bumpEpoch();});const r=this.db.prepare('SELECT body FROM settings WHERE key=?').get(key)       ;return r?JSON.parse(r.body):undefined;}
  commitExtraction(candidates         ,ctx             ,epoch       ,sourceRef                         ){return this.transaction(()=>{if((this.setting('writeEpoch')??0)!==epoch||this.setting('autoMode')==='off'||!this.setting('model')?.enabled)return false;for(const content of candidates)this.add({content,scope:ctx.project?'project':'global',sourceType:'inferred',status:'pending',sourceRef},ctx);return true;});}
  budgets(){return validateBudgets(this.setting('budgets')??{});}
  // 常驻注入的选入规则：身份、偏好、约束三类才是"下个对话仍然成立"的东西。
  // 只取 active（pending/过期/待复核的一律不进常驻，那是待确认区的事）。
  // 排序固定：profile → preference → constraint，同类按更新时间新→旧，
  // 这样前缀字节只随内容变化，不会因为 Map 顺序或时间戳抖动。
  core(ctx             ){const now=Date.now();const order=['profile','preference','constraint'];return this.all().filter(r=>this.accessible(r,ctx)&&order.indexOf(r.category)>=0&&r.status==='active'&&(!r.expiresAt||Date.parse(r.expiresAt)>now)&&(!r.reviewAt||Date.parse(r.reviewAt)>now)).sort((a,b)=>{const d=order.indexOf(a.category)-order.indexOf(b.category);return d!==0?d:String(b.updatedAt??'').localeCompare(String(a.updatedAt??''))}).slice(0,12);}
  metric(key       ,value=1){if(this.setting('maintenance'))return;this.db.prepare('INSERT INTO metrics VALUES (?,?,?) ON CONFLICT(day,key) DO UPDATE SET value=value+excluded.value').run(new Date().toISOString().slice(0,10),key,value);}
  stats(ctx             ){return {schemaVersion:1,visibleRecords:this.all().filter(r=>this.accessible(r,ctx)).length,autoMode:this.setting('autoMode')??'candidates',modelExtraction:this.setting('model')?.enabled??false,metrics:this.db.prepare('SELECT * FROM metrics ORDER BY day,key').all(),tokenMethod:'UTF-8 byte upper-bound estimate; actual usage only when provider returns it',conversationUsage:null,cost:null};}
}
