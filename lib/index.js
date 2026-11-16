import {join} from 'node:path';
import {existsSync,mkdirSync,writeFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {MemoryStore,scopeContext,                 } from './core.js';
import {pack,estimateTokens,recallQueries,renderCore} from './retrieval.js';
import {safeError,fail,text} from './safety.js';
import {ruleCandidate,ExtractionQueue,extract} from './automation.js';
import {loadSoul} from './soul.js';
import {mountPanel} from './panel.js';
import {mountCommands} from './command.js';
import {dshHome, readPointer} from './location.js';
import {WorkStore} from './work.js';
import {mountSkills} from './skills.js';
import {buildMemorySummary} from './summary.js';
import {createPersonalization,memoryProfileRecords} from './personalization.js';
import {IncrementalGate} from './gate.js';
import {FileLock} from './lock.js';
import {unload,readSpill} from './unload.js';
export {Config} from './settings.js';
export const name='mymemory';
export const inject=['tools','systemPrompt'];
export function defaultDataDir(profile='desktop',home=process.env.DSH_HOME||join(homedir(),'.dsh')){if(!/^[a-z0-9_-]+$/i.test(profile))fail('INVALID_PROFILE');return join(home,'mymemory',profile);}
export function resolveDataDir(ctx    ,config    ){const profile=typeof ctx.get==='function'?ctx.get('profileContext'):undefined;return readPointer(dshHome(ctx),config.profile??profile?.name??'desktop')||config.dataDir||defaultDataDir(config.profile??profile?.name??'desktop',profile?.home??process.env.DSH_HOME??join(homedir(),'.dsh'));}
const actions=['add','search','get','update','forget','list','stats','export','handoff_save','handoff_list','handoff_get','skill_propose','skill_list','skill_get','skill_use','skills','skill_promote','skill_deprecate','temporary','summary','suppress','unsuppress','inspect','conflicts','resolve'];
function verifiedUserContent(message                 ,content       )         {
  if(!message)return false;
  if(/[“”"「」『』]/u.test(message)||/不要|别记|不是|没有|并未|不代表|don't|not my/i.test(message))return false;
  const candidate=ruleCandidate(message);
  if(candidate?.content===content)return true;
  if(message===content&&/^(?:我的|我现在|我改变主意|我决定|我确认|以后|I |My )/i.test(message))return true;
  // 无法确定的模型改写进入候选，词语重合不是来源证明。
  return false;
}
export function apply(ctx    ,config    ={}) {
  const dataDir=resolveDataDir(ctx,config);
  let store                      ;try{store=new MemoryStore(join(dataDir,'memory.sqlite'));}catch{/* normal chat stays available */}
  const s=store;
  const getNativeLlm=()=>{try{return typeof ctx.get==='function'?ctx.get('llm'):undefined;}catch{return undefined;}};
  // 跨进程写锁 + 三级网关。锁自愈靠 ttl 与 pid 探活：宿主被强杀时没人来清理。
  // 后台模型路由的兜底：extraction 没配就跟当前会话实际在跑的模型（宿主默认 Flash）。
  let sessionRoute                                         ;
  /* 路由抓不到时得知道是字段名变了还是事件没来，先留一份现场。 */
  let headerProbe    ;
  // 重启到第一次模型调用之间没有会话路由；把上次用过的存进库里，否则刚开机就点「更新」只会拿到 NO_ROUTE。
  const rememberRoute=(r                               )=>{sessionRoute=r;try{s?.setting('lastRoute',r);}catch{/* contained */}};
  const routeNow=()                                         =>{try{const o    =s .setting('extraction');if(o?.provider&&o?.model)return{provider:String(o.provider),model:String(o.model)};if(sessionRoute)return sessionRoute;const last    =s .setting('lastRoute');if(last?.provider&&last?.model)return{provider:String(last.provider),model:String(last.model)};}catch{/* contained */}return undefined;};
  const lock=s?new FileLock(join(dataDir,'.memory.lock'),60000):undefined;
  const gate=s?new IncrementalGate({store:s,lock,budgets:()=>s .budgets(),llm:getNativeLlm,route:routeNow}):undefined;
  const personal=s?createPersonalization(s,getNativeLlm,gate,()=>config.soulPath??dataDir):undefined;
  const work=s?new WorkStore(s):undefined;
  const skillAdapter=work?mountSkills(ctx,work):{available:false,changed:()=>{}};
  // config 只做首次初始化：库里已经有值就以库为准，
  // 否则面板改的设置会被每次重启的配置文件冲掉。
  try{
    if(s&&config.budgets&&!s.setting('budgets'))s.setting('budgets',config.budgets);
    if(s&&config.autoMode&&!s.setting('autoMode'))s.setting('autoMode',config.autoMode);
    // 面板改的值优先：配置文件只在库里还没有 extraction 时生效，否则每次重启都会把面板设置冲掉。
    if(s&&!s.setting('extraction')&&(config.extractionProvider||config.extractionModel))s.setting('extraction',{provider:config.extractionProvider,model:config.extractionModel});
  }catch{s?.metric('config_apply_failed');}
  // 检索默认给索引卡片：一条几十 token，要原文再 get。整段正文一次灌进来，赚这一轮，赔之后每一轮。
  const card=(r    )=>({id:r.id,summary:r.content.length>90?r.content.slice(0,90)+'…':r.content,category:r.category,scope:r.scope,source:r.sourceType,validAt:r.updatedAt,...(r.invalidAt?{invalidAt:r.invalidAt}:{}),...(r.status==='active'?{}:{status:r.status})});
  let activeCwd                 ;
  const budgets=s?.budgets();
  const sessions=new Map                                                            ();
  let disposed=false;
  const model=s?.setting('model');
  const q=model?.enabled?new ExtractionQueue(budgets??{},async(message,signal,meta)=>{
    const day=new Date().toISOString().slice(0,10);const key='extraction:'+day;
    const allowed=s .transaction(()=>{const used=s .setting(key)??0;if(used>=s .budgets().dailyLimit||s .setting('autoMode')==='off'||!s .setting('model')?.enabled||(s .setting('writeEpoch')??0)!==meta.epoch)return false;s .setting(key,used+1);return true;});
    if(!allowed){s .metric('extraction_skipped');return;}
    s .metric('extraction_calls');s .metric('extraction_input_estimated',estimateTokens(message.slice(0,budgets .extractionInputChars)));
    try{const result=await extract(message,signal,{...model,...budgets});if(signal.aborted||disposed)return;
      if(!s .commitExtraction(result.candidates,meta.ctx,meta.epoch,{sessionId:meta.ctx.sessionId,messageId:meta.messageId}))s .metric('extraction_skipped');
      for(const field of ['prompt_tokens','completion_tokens'])if(Number.isFinite(result.usage?.[field]))s .metric('extraction_actual_'+field,result.usage[field]);
    }catch{s .metric('extraction_errors');}
  }):undefined;
  function rememberSession(session    ,event    ){
    if(!s||disposed||event.type!=='user/message'||session?.header?.origin==='subagent'||event.data?.source?.kind!=='user')return;
    const message=typeof event.data.content==='string'?event.data.content:(event.data.content??[]).filter((v    )=>v.type==='text').map((v    )=>v.text).join('\n');
    if(!message||message.length>8000)return;
    const context=scopeContext(session.header?.cwd,session.id),messageId=String(event.seq??'');
    if(context.project)activeCwd=session.header?.cwd;
    // One item per session; cap retained sessions without caching memory contents.
    if(sessions.size>=128&&!sessions.has(session.id))sessions.delete(sessions.keys().next().value );
    const old=sessions.get(session.id);if(old?.messageId===messageId)return;
    sessions.set(session.id,{ctx:context,message,messageId});
    if(!personal?.enabled(session.id)||!personal.preferences().automaticLearning)return;
    const mode=s.setting('autoMode')??'candidates';if(mode==='off'||(getNativeLlm()?.prepareCall&&personal?.preferences().automaticLearning))return;
    const candidate=ruleCandidate(message);
    if(candidate){try{s.add({...candidate,scope:context.project?'project':'global',status:mode==='conservative'&&candidate.sourceType==='user_remember'?candidate.status:'pending',sourceRef:{sessionId:session.id,messageId}},context);}catch{s.metric('auto_skipped');}}
    else if(q&&!q.enqueue(message,{ctx:context,messageId,epoch:s.setting('writeEpoch')??0},session.id+':'+messageId))s.metric('extraction_skipped');
  }
  ctx.on('session/event',(session    ,event    )=>{try{if(event?.type==='request/header'){const c=event.data?.header?.config;headerProbe={dataKeys:Object.keys(event.data||{}),headerKeys:Object.keys(event.data?.header||{}),config:c??null};if(c?.provider&&c?.model)rememberRoute({provider:String(c.provider),model:String(c.model)});}personal?.observe(session,event)?.catch(()=>{});rememberSession(session,event);}catch{/* contained */}});
  // 后台模型路由：llm/stream 是宿主自己声明的 waterfall，每次调用都带 provider/model，
  // 比猜 session 事件的字段稳。必须 return next()，否则整条流被掐断。
  try{ctx.on('llm/stream',(options    ,next    )=>{try{const p=options?.provider,m=options?.model;if(typeof p==='string'&&typeof m==='string'&&p&&m)rememberRoute({provider:p,model:m});}catch{/* contained */}return next();});}catch{s?.metric('llm_stream_unavailable');}
  ctx.on('agent/disposed',(payload    )=>{sessions.delete(payload?.agent?.id);});
  // 只认根代理：子代理的回合不该触发整理，否则一次并行派发会把同一段对话抽三遍。
  try{ctx.on('agent/turn-stopping',(payload    )=>{const agent=payload?.agent??payload;if(agent?.session?.header?.origin==='subagent')return;const job=personal?.flush(agent?.session?.id);if(job)job.catch(()=>{});});}catch{s?.metric('turn_stopping_unavailable');}
  const provider={name:'mymemory',order:90,interpolate:false,text:(assembly    )=>{
    // 摘要每轮重算，绝不能进系统提示：它一变，从第 0 token 起的前缀缓存就整段作废。
    // 折进这段尾部快照，改动只落在末尾。
    const profileText=(()=>{try{return personal?.profile(assembly.agent??assembly.scope)??''}catch{return ''}})();
    if(!s||disposed||!personal?.enabled(assembly.agent?.session?.id??assembly.scope?.id))return profileText;
    try{const id=assembly.agent?.session?.id??assembly.scope?.id;const state=sessions.get(id);if(!state)return profileText;
      const query=(ruleCandidate(state.message)?.content??state.message).replace(/^(?:请|帮我|我们|我的|我想|之前的|关于)+/g,'').replace(/(?:是多少|是什么|进行到哪一步了|怎么样|还记得吗|[？?。！!])/g,' ').trim().slice(0,256);
      if(!query)return profileText;
      const limits=s.budgets();const coreRecords=s.core(state.ctx).filter(r=>personal .allowed(r));const core=renderCore(coreRecords,{budget:limits.coreBudget});
      const found      =[];const seen            =new Set();
      for(const level of recallQueries(query)){for(const q of level){for(const r of s.search(q,state.ctx,{limit:limits.maxResults}).filter(r=>personal .allowed(r))){if(seen.has(r.id))continue;seen.add(r.id);found.push(r);}}if(found.length)break;}
      const coreIds=new Set(coreRecords.map((r    )=>r.id));const results=found.filter(r=>!coreIds.has(r.id));const related=pack(results,{budget:limits.retrievalBudget});
      const result={text:core.text+related.text,count:core.count+related.count,estimatedTokens:core.estimatedTokens+related.estimatedTokens};
      const handoff=personal .preferences().referenceHistory&&/继续|进度|交接|接手|进行到/.test(state.message)?work?.list('handoff',state.ctx)[0]:undefined;
      const index=handoff?`\n项目交接可按需读取：handoff_get id=${handoff.id}\n`:'';
      const combined=estimateTokens(result.text+index)<=limits.retrievalBudget+limits.coreBudget?result.text+index:result.text;
      s.metric('injection_assemblies');s.metric('injected_records',result.count);const body=profileText?(combined?profileText+'\n\n'+combined:profileText):combined;s.metric('injected_estimated_tokens',estimateTokens(body));return body;
    }catch{return profileText;}
  }};
  // 人格单独成段、排在检索段之前：它是整个系统提示里最稳定的部分，
  // 混进按 query 重算的检索段会每轮撕开前缀，缓存全废。
  let soul                                                      =null;
  const soulDir=config.soulPath??dataDir;
  // 首启没有 USER.md：用已有摘要起个草，用户打开面板看到的是能直接改的人物小传，不是空框。
  try{
    if(s&&!existsSync(join(soulDir,'USER.md'))){
      // 首稿只放精选画像：把整份摘要倒进去，等于开局就塞满流水账。
      const draft=memoryProfileRecords(s).map(r=>r.content.trim()).filter(Boolean).join('\n\n');
      if(draft.trim()){const cap=s.budgets().profileBudgetChars;mkdirSync(soulDir,{recursive:true,mode:0o700});writeFileSync(join(soulDir,'USER.md'),(draft.length>cap?draft.slice(0,cap):draft)+'\n','utf8');s.metric('persona_seeded');}
    }
  }catch{s?.metric('persona_seed_failed');}
  // 人格走闭包而不是固定值：设置页改完立刻生效，下一轮组装就用新文本。
  // 平时每轮返回同一个字符串，前缀不变，缓存照命中。
  let soulText='';
  try{
    const loaded=loadSoul(soulDir);
    soul=loaded;soulText=loaded.overLimit?'':loaded.text;
    ctx.systemPrompt.section({name:'mymemory-soul',order:80,text:()=>soulText});
    if(loaded.overLimit)s?.metric('soul_over_limit');
  }catch{s?.metric('soul_section_failed');}
  // 使用说明是固定文本，不随检索结果变：属于稳定前缀，可以缓存。
  // 没有这段话时，模型只在工具列表里看到 mymemory 的签名，不会主动想到“该去查”。
  const GUIDE=[
    '## DSH记忆',
    '后台沿用当前DSH模型自动整理身份、偏好和有来源的工作观察；仅成功返回后才说已保存。不要要求用户填写交接或维护Skill。',
    '用户问记得什么时用summary，用自然中文回答。回忆时search；来源不足、pending或过时记录不能当事实。',
    '明确要求记住用add；纠正先get再update并带expectedVersion。不要把推测、第三人或引用当用户身份，不保存敏感信息。',
    '忘记先search定位再forget，查不到可list查暂停项。不要再提用suppress，恢复引用用list定位后unsuppress；暂停引用不是删除。',
    '开启临时对话用temporary(true)，恢复正常对话用temporary(false)。临时会话不使用或保存插件记忆，但不改变DSH聊天历史。',
    '关闭自动学习时，除非用户明确要求保存/纠正，不得自行调用新增或修改工具。全局仅放用户长期资料，工作经验按项目隔离。',
    '## 写记忆的准则',
    '只记下个对话仍然成立的事：身份、偏好、约束、环境和项目约定。任务进度、临时路径、一次性的指令不记。',
    '一条只写一个事实，陈述句，80 字以内；已有同类条目时改写它，不要新增第二条。',
    '不记报错原文、命令输出、对话里的困惑或试探——那些属于当轮上下文。',
    '经验（这类活怎么干）写进 skill，不写进记忆。',
    '拿不准就跳过：少记一条的代价，远小于记错一条。'
].join('\n');
  try{ctx.systemPrompt.section({name:'mymemory-guide',order:85,text:()=>personal?.preferences().enabled?GUIDE:''});}catch{s?.metric('guide_section_failed');}
  ctx.systemPrompt.context(provider);
  mountCommands(ctx,{store:s,work,gate});
 mountPanel(ctx,{store:s,work,skillAdapter,dataDir,home:dshHome(ctx),profile:config.profile??(typeof ctx.get==='function'?ctx.get('profileContext')?.name:undefined)??'desktop',soulDir,soul,getCwd:()=>activeCwd,onSoulSaved:(next       )=>{soulText=next;soul=loadSoul(soulDir);},onDistill:()=>personal?personal.redistill(routeNow()):Promise.resolve({updated:false}),onDistillApply:(text       )=>personal?personal.applyPersona(text):Promise.resolve({updated:false})});
  ctx.tools.register({name:'mymemory',description:'本地记忆、项目交接和经验Skill。事实add/search/get/update/forget；完成工作handoff_save，接手handoff_list/get；方法skill_propose，使用后skill_use。经验按工具观测直接生效，更新须expectedVersion，技能证据齐备即启用。',parameters:{type:'object',additionalProperties:false,properties:{temporary:{type:'boolean'},taskId:{type:'string',maxLength:160},title:{type:'string',maxLength:160},body:{type:'string',maxLength:2000},name:{type:'string',maxLength:100},description:{type:'string',maxLength:256},evidenceIds:{type:'array',maxItems:20,items:{type:'string',maxLength:100}},outcome:{type:'string',enum:['success','failure','unknown']},action:{type:'string',enum:actions},content:{type:'string',maxLength:2000},id:{type:'string',maxLength:100},query:{type:'string',maxLength:256},scope:{type:'string',enum:['global','workspace','project']},category:{type:'string',enum:['profile','preference','constraint','recent','project','episode','experience']},sourceType:{type:'string',enum:['user_explicit','user_remember','user_correction','assistant_suggestion','user_confirmed','inferred','external','unknown','tool_observation']},factKey:{type:'string',maxLength:100},expectedVersion:{type:'integer',minimum:1},expiresAt:{type:'string'},reviewAt:{type:'string'},offset:{type:'integer',minimum:0},limit:{type:'integer',minimum:1,maximum:1000},path:{type:'string',maxLength:512},accept:{type:'boolean'}},required:['action']},output:{schema:{type:'object'},render:(_args    ,result    )=>[{type:'text',text:JSON.stringify(result)}]},
    async execute(args    ,exec    ={}){
      try{if(!s||disposed)fail('PLUGIN_UNAVAILABLE');exec.signal?.throwIfAborted();
        if(!args||typeof args!=='object'||!actions.includes(args.action))fail('INVALID_ACTION');
        const allowed=['action','content','id','query','scope','category','sourceType','factKey','expectedVersion','expiresAt','reviewAt','offset','limit','taskId','title','body','name','description','evidenceIds','outcome','temporary','path','accept'];if(Object.keys(args).some(k=>!allowed.includes(k)))fail('INVALID_ARGUMENT');
        if(args.limit!==undefined&&(!Number.isInteger(args.limit)||args.limit<1||args.limit>(args.action==='inspect'?1000:20)))fail('INVALID_LIMIT');
        if(args.offset!==undefined&&(!Number.isInteger(args.offset)||args.offset<0))fail('INVALID_OFFSET');
        const session=exec.agent?.session;const context=scopeContext(session?.header?.cwd,session?.id);const state=sessions.get(session?.id);
        if(args.action==='temporary'){if(!session?.id||typeof args.temporary!=='boolean'||!state?.message||!(/临时|不使用记忆|不要记|暂停记忆|恢复|正常对话|temporary|resume/i.test(state.message)))fail('EXPLICIT_REQUEST_REQUIRED');return {ok:true,data:personal .setTemporary(session.id,args.temporary)};}
        if(args.action!=='stats'&&!personal?.enabled(session?.id))fail('MEMORY_DISABLED_OR_TEMPORARY');
        if(['add','update','handoff_save','skill_propose'].includes(args.action)&&!personal .preferences().automaticLearning&&!/记住|remember|改成|纠正|更正|更新|保存/i.test(state?.message??''))fail('AUTOMATIC_LEARNING_DISABLED');
        let data    ;
        switch(args.action){
          case 'add':{const content=text(args.content);const verified=verifiedUserContent(state?.message,content);// 经验记的是"这事怎么成的"，依据是本会话的工具输出而不是主人原话：套用户事实的确认门槛，等于每次沉淀都要他点一次。
          const experiential=args.category==='experience';const input    ={...args,scope:args.scope??(context.project?'project':'global'),sourceType:verified?'user_explicit':experiential?'tool_observation':'inferred',status:verified||experiential?undefined:'pending',sourceRef:{sessionId:session?.id,...(state?.messageId?{messageId:state.messageId}:{})}};const gated=gate&&s.setting('autoMode')!=='off'?await gate.ingest(content,context,input):undefined;if(gated)data=gated.conflict?{conflict:gated.conflict,decision:gated.decision,note:'涉及核心偏好的改动已挂起，用 action=resolve 裁决'}:gated.record??gated.decision;else data=s.add(input,context);// 用户逐字确认过的内容若落到既有 pending 副本上，仍要提正为 active，否则"记住"等于没记住。
          if((verified||experiential)&&data?.status==='pending'&&data.id)data=s.update(data.id,{content,expectedVersion:data.version,sourceType:verified?'user_explicit':'tool_observation'},context);break;}
          case 'update':{const content=text(args.content);const verified=verifiedUserContent(state?.message,content);data=s.update(args.id,{...args,content,sourceType:verified?'user_correction':'inferred',sourceRef:{sessionId:session?.id,messageId:state?.messageId}},context);break;}
          case 'get':if(!personal .allowed(s.get(args.id,context)))fail('HISTORY_REFERENCE_DISABLED');data={...s.get(args.id,context),history:s.history(args.id,context)};break;
          // pending 也要能被模型查到，否则"记了等于没记"；注入侧仍只取 active，提示词不会被未确认内容污染。
          // 待裁决冲突跟着卡片一起出：模型要知道这条结论有争议，而不是只看到其中一方。
          case 'search':{const open=s.conflicts();const hits=s.search(args.query,context,{...args,includePending:true}).filter(r=>personal .allowed(r)).map(r=>{const hit=card(r),c=open.find((x    )=>x.targetId===r.id);return c?{...hit,conflict:{id:c.id,proposal:c.proposal,reason:c.reason,note:'待裁决，卡片可能是旧结论；用 action=resolve 处理'}}:hit;});const skills=work?work.cards(String(args.query??''),context):[];data=skills.length?{memories:hits,skills}:hits;break;}
          case 'list':data=s.list(context,args).filter(r=>personal .allowed(r));break;
          // 物理删除前先落一份可读快照：删掉就真没了，事后要追只能靠这份文件。
          case 'forget':{const target=s.get(args.id,context);const dir=join(dataDir,'forget');mkdirSync(dir,{recursive:true,mode:0o700});const stamp=new Date().toISOString().replace(/[:.]/g,'-');const file=join(dir,target.id+'-'+stamp+'.json');writeFileSync(file,JSON.stringify({...target,history:s.history(target.id,context)},null,2),{encoding:'utf8',flag:'wx',mode:0o600});await q?.cancel();sessions.clear();data={...s.forget(args.id,context),backup:file};break;}
          case 'stats':data={...s.stats(context),gate:gate?.stats(),conflicts:s.conflicts().length,extraction:(s.setting('extraction')       )??null,route:sessionRoute??null,headerProbe:headerProbe??null,llmKeys:(()=>{try{return Object.keys(getNativeLlm()||{})}catch{return []}})()};break;
          // 大载荷回读：路径限制在 spill 目录内，越界由 readSpill 的 realpath 比较拦下。
          case 'inspect':data=readSpill(join(dataDir,'spill'),text(args.path,512),args.offset??0,args.limit??200);break;
          case 'conflicts':data=s.conflicts(Boolean(args.accept));break;
          case 'resolve':data=s.resolveConflict(text(args.id,100),Boolean(args.accept),context);break;
          case 'suppress':case 'unsuppress':{if(!state?.message||!(/不要再提|别再提|不再使用|暂停引用|恢复使用|恢复引用/.test(state.message)))fail('EXPLICIT_REQUEST_REQUIRED');const old=s.get(args.id,context);data=s.update(old.id,{content:old.content,expectedVersion:args.expectedVersion,sourceType:old.sourceType,reviewAt:args.action==='suppress'?new Date(0).toISOString():undefined},context);break;}
          case 'summary':data={summary:buildMemorySummary(s,context),profile:personal .profile(exec.agent),memories:s.list(context).filter(r=>personal .allowed(r)).map(r=>({content:r.content,category:r.category,source:r.sourceRef})),settings:personal .preferences()};break;
          case 'export':{const all=s.export(context);data={...all,records:all.records.filter(r=>personal .allowed(r))};break;}
          case 'handoff_save':data=work .saveHandoff({...args,sourceRef:{sessionId:session?.id,messageId:state?.messageId}},context);break;
          case 'handoff_list':if(!personal .preferences().referenceHistory)fail('HISTORY_REFERENCE_DISABLED');data=work .list('handoff',context).slice(0,20).map(({body,...r})=>r);break;
          case 'handoff_get':if(!personal .preferences().referenceHistory)fail('HISTORY_REFERENCE_DISABLED');data=work .get(args.id,context);if(data.kind!=='handoff')fail('INVALID_KIND');break;
          case 'skill_propose':{const proposed=work .proposeSkill({...args,sourceRef:{sessionId:session?.id,messageId:state?.messageId}},context);// 证据齐备就当场启用：主人不该被拉来当 Skill 审稿人，没通过的留在草稿区等下次补证。
          try{data=work .autoActivateSkill(proposed.id,proposed.version,context);}catch{data={...proposed,note:'草稿：证据尚未齐备，补上 evidenceIds 后会自动启用'};}break;}
          case 'skill_list':data=work .list('skill',context).slice(0,20).map(({body,...r})=>r);break;
          case 'skill_get':data=work .loadSkill(text(args.name,100),context);break;
          case 'skill_use':data=work .recordUse({id:args.id,version:args.expectedVersion,outcome:args.outcome,evidenceIds:args.evidenceIds},context);break;
          case 'skills':data=work .cards(String(args.query??''),context);break;
          case 'skill_promote':data=work .setSkillStage(text(args.id,100),args.expectedVersion          ,'verified',context);break;
          case 'skill_deprecate':data=work .setSkillStage(text(args.id,100),args.expectedVersion          ,'deprecated',context);break;
        }skillAdapter.changed();
        // 超大结果落盘只回指针：省的是之后每一轮都要重付的输入，不是这一次的输出。
        if(args.action!=='inspect'){const spill=unload(join(dataDir,'spill'),'mymemory-'+args.action,JSON.stringify(data),{threshold:s?.budgets().spillThreshold??60000});if(spill){s?.metric('spilled_results');return {ok:true,data:{spilled:spill,hint:'结果已落盘，用 action=inspect path='+spill.path+' 按行回读'}};}}
        return JSON.parse(JSON.stringify({ok:true,data}));
      }catch(error){return {ok:false,error:{code:safeError(error)}};}
    }
  });
  ctx.effect(()=>async()=>{disposed=true;sessions.clear();await q?.close();await personal?.close();lock?.release();s?.close();});
  return {store:s,work,skillAdapter,provider,personalization:personal,gate,lock};
}
