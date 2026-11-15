import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {apply} from '../src/index.ts';

test('profile survives an empty retrieval query',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'mymemory-profile-p0-'));
  let tool,provider;const handlers=new Map(),cleanup=[];
  const ctx={tools:{register(t){tool=t}},systemPrompt:{context(p){provider=p}},on(e,fn){handlers.set(e,fn)},effect(fn){cleanup.push(fn())}};
  apply(ctx,{dataDir:dir});
  const agent={id:'p0',session:{id:'p0',header:{cwd:dir}}};
  try{
    handlers.get('session/event')(agent.session,{type:'user/message',seq:1,data:{source:{kind:'user'},content:[{type:'text',text:'记住：我是大三自动化专业的学生'}]}});
    const added=await tool.execute({action:'add',content:'我是大三自动化专业的学生',category:'profile',scope:'global',sourceType:'user_explicit'},{agent});
    assert.equal(added.data.status,'active');
    handlers.get('session/event')(agent.session,{type:'user/message',seq:2,data:{source:{kind:'user'},content:[{type:'text',text:'？'}]}});
    const injected=provider.text({scope:agent,agent});
    assert.ok(injected.includes('自动化专业'),'检索为空时摘要必须仍然注入 injected='+JSON.stringify(injected));
  }finally{for(const f of cleanup)await f?.();rmSync(dir,{recursive:true,force:true});}
});
