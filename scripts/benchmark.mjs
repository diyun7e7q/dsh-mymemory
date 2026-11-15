import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {MemoryStore,scopeContext} from '../src/core.ts';
import {pack} from '../src/retrieval.ts';
const dir=mkdtempSync(join(tmpdir(),'mymemory-bench-'));const store=new MemoryStore(join(dir,'memory.sqlite'));const ctx=scopeContext(dir);
const dataset=[['VPS 每月预算最高30元','VPS 预算'],['MyMemory 使用 SQLite','MyMemory SQLite'],['偏好中文解释','中文'],['控制系统课程项目','控制系统'],['喜欢苹果','火星天气']];
try{
  for(const [content] of dataset)store.add({content,sourceType:'user_explicit'},ctx);
  const start=performance.now();let correct=0,estimated=0;
  for(const [content,query] of dataset){const records=store.search(query,ctx);if(query==='火星天气'?records.length===0:records[0]?.content===content)correct++;estimated+=pack(records).estimatedTokens;}
  console.log(JSON.stringify({kind:'offline_synthetic_retrieval_only',cases:dataset.length,correct,searchAndPackingMs:performance.now()-start,modes:[{mode:'no_plugin',injectedEstimatedTokens:0,taskSuccess:null,totalModelTokens:null,cost:null},{mode:'plugin_no_extraction',injectedEstimatedTokens:estimated,taskSuccess:null,totalModelTokens:null,cost:null},{mode:'plugin_model_extraction',status:'not_run_no_model_credentials',taskSuccess:null,totalModelTokens:null,cost:null}],note:'UTF-8字节保守估算；不证明真实任务成功率或比其他插件省费用。'},null,2));
}finally{store.close();rmSync(dir,{recursive:true,force:true});}
