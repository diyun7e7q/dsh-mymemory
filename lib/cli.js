#!/usr/bin/env node
import {parseArgs} from 'node:util';
import {join,resolve} from 'node:path';
import {readFileSync,writeFileSync,statSync,existsSync} from 'node:fs';
import {backup} from 'node:sqlite';
import {MemoryStore,scopeContext} from './core.js';
import {defaultDataDir} from './index.js';
import {fail,safeError} from './safety.js';
import {validateBudgets} from './config.js';
import {WorkStore} from './work.js';
import {readPointer} from './location.js';
import {homedir} from 'node:os';
const {values:v,positionals}=parseArgs({allowPositionals:true,options:Object.fromEntries(['data-dir','cwd','profile','content','id','query','scope','category','fact-key','version','file','mode','endpoint','model','offset','expires-at','review-at','task-id','title','name','description','evidence','revision','outcome'].map(k=>[k,{type:'string'}]).concat([['ack-data-sharing',{type:'boolean'}],['enable',{type:'boolean'}]]       ))});
const opts=v       ;let store                      ;
try{
  const command=positionals[0]??'help';
  if(command==='help'){console.log(JSON.stringify({usage:'node lib/cli.js [--data-dir PATH] [--cwd PROJECT] COMMAND [OPTIONS]',commands:['add --content TEXT [--scope global|workspace|project]','update --id ID --version N --content TEXT','get --id ID','history --id ID','search --query TEXT','list [--offset N]','forget --id ID','stats','handoff-save --task-id TASK --title TITLE --content TEXT [--evidence ID,ID]','handoff-list','handoff-get --id ID','skill-propose --name mymemory-NAME --title TITLE --description TRIGGER --content METHOD --evidence ID,ID','skill-review --id ID --version N','skill-enable --id ID --version N','skill-disable --id ID --version N','skill-get --name NAME','skill-list','skill-rollback --id ID --version N --revision OLD','export --file PATH','import --file PATH','backup --file PATH','config [--file JSON_PATH]','reindex','auto --mode off|candidates|conservative','model [--enable --endpoint HTTPS_URL --model NAME --ack-data-sharing]']}));}
  else{
    const dataDir=opts['data-dir']?resolve(opts['data-dir']):readPointer(process.env.DSH_HOME??join(homedir(),'.dsh'),opts.profile??'desktop')||defaultDataDir(opts.profile??'desktop');if(!opts['data-dir']&&!existsSync(join(dataDir,'memory.sqlite')))fail('DATA_DIR_REQUIRED');
    store=new MemoryStore(join(dataDir,'memory.sqlite'));const s=store,work=new WorkStore(s);const evidenceIds=String(opts.evidence??'').split(',').map(x=>x.trim()).filter(Boolean);
    const ctx=scopeContext(opts.cwd??process.cwd());let result    ;
    switch(command){
      case 'handoff-save':result=work.saveHandoff({id:opts.id,taskId:opts['task-id'],title:opts.title,body:opts.content,scope:opts.scope,evidenceIds,...(opts.version?{expectedVersion:Number(opts.version)}:{})},ctx);break;
      case 'handoff-list':result=work.list('handoff',ctx);break;
      case 'handoff-get':result=work.get(opts.id,ctx);break;
      case 'skill-propose':result=work.proposeSkill({id:opts.id,name:opts.name,title:opts.title,description:opts.description,body:opts.content,scope:opts.scope,evidenceIds,...(opts.version?{expectedVersion:Number(opts.version)}:{})},ctx);break;
      case 'skill-review':result=work.validateSkill(opts.id,Number(opts.version),ctx,{userApproved:true});break;
      case 'skill-enable':result=work.setSkillState(opts.id,Number(opts.version),'active',ctx);break;
      case 'skill-disable':result=work.setSkillState(opts.id,Number(opts.version),'disabled',ctx);break;
      case 'skill-list':result=work.list('skill',ctx);break;
      case 'skill-get':result=work.loadSkill(opts.name,ctx);break;
      case 'skill-rollback':result=work.rollbackSkill(opts.id,Number(opts.version),Number(opts.revision),ctx);break;
      case 'skill-use':result=work.recordUse({id:opts.id,version:Number(opts.version),outcome:opts.outcome??'unknown',evidenceIds},ctx,{userApproved:true});break;
      case 'add':result=s.add({content:opts.content,scope:opts.scope??'project',category:opts.category??'project',sourceType:'user_remember',factKey:opts['fact-key'],expiresAt:opts['expires-at'],reviewAt:opts['review-at']},ctx);break;
      case 'update':result=s.update(opts.id,{content:opts.content,expectedVersion:Number(opts.version),sourceType:'user_correction',...(opts['expires-at']?{expiresAt:opts['expires-at']}:{}),...(opts['review-at']?{reviewAt:opts['review-at']}:{})},ctx);break;
      case 'get':result=s.get(opts.id,ctx);break;
      case 'history':result=s.history(opts.id,ctx);break;
      case 'list':{const offset=Number(opts.offset??0);if(!Number.isInteger(offset)||offset<0)fail('INVALID_OFFSET');result=s.list(ctx,{offset});break;}
      case 'search':result=s.search(opts.query,ctx);break;
      case 'forget':result=s.forget(opts.id,ctx);break;
      case 'stats':result=s.stats(ctx);break;
      case 'config':if(opts.file){if(statSync(opts.file).size>10000)fail('CONFIG_TOO_LARGE');s.setting('budgets',validateBudgets(JSON.parse(readFileSync(opts.file,'utf8'))));}result={budgets:s.budgets(),reloadRequired:Boolean(opts.file)};break;
      case 'reindex':result=s.reindex();break;
      case 'export':if(!opts.file)fail('FILE_REQUIRED');writeFileSync(resolve(opts.file),JSON.stringify(s.export(ctx),null,2),{flag:'wx',mode:0o600});result={exported:true,file:resolve(opts.file),plaintext:true};break;
      case 'backup':if(!opts.file)fail('FILE_REQUIRED');if(existsSync(opts.file))fail('FILE_EXISTS');await backup(s.db,resolve(opts.file));result={backedUp:true,file:resolve(opts.file),includes:'all scopes, revisions, tombstones, settings and metrics',encrypted:false};break;
      case 'import':if(!opts.file)fail('FILE_REQUIRED');if(statSync(opts.file).size>100_000_000)fail('IMPORT_TOO_LARGE');result=s.import(JSON.parse(readFileSync(opts.file,'utf8')),ctx);break;
      case 'auto':if(!['off','candidates','conservative'].includes(opts.mode))fail('INVALID_MODE');s.setting('autoMode',opts.mode);result={autoMode:opts.mode,reloadRequired:false};break;
      case 'model':{
        if(!opts.enable){s.setting('model',{enabled:false});result={enabled:false,reloadRequired:true};break;}
        if(!opts['ack-data-sharing']||!opts.endpoint||!opts.model)fail('MODEL_CONSENT_REQUIRED');
        const url=new URL(opts.endpoint);if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash)fail('INVALID_ENDPOINT');
        const limits=s.budgets();s.setting('model',{enabled:true,endpoint:url.href,model:opts.model});result={enabled:true,recipient:url.origin,model:opts.model,data:`当前用户消息，截断至${limits.extractionInputChars}字符；不发送记忆库或完整会话。可能产生模型费用。API密钥只从MYMEMORY_API_KEY读取。`,limits:{dailyCalls:limits.dailyLimit,minIntervalMs:limits.minIntervalMs,outputTokens:limits.extractionOutputTokens,inputChars:limits.extractionInputChars},reloadRequired:true};break;
      }
      default:fail('UNKNOWN_COMMAND');
    }console.log(JSON.stringify(result,null,2));
  }
}catch(error){console.error(JSON.stringify({ok:false,error:safeError(error)}));process.exitCode=1;}finally{store?.close();}

