import {scopeContext} from './core.js';
import {safeError} from './safety.js';

const TRUSTED=['user_explicit','user_remember','user_confirmed','user_correction'];
const USAGE='/mymemory status | conflicts | skills | resolve <id> accept|reject | skill <id> promote|deprecate';

function grade(r    ){
 if(r.status==='superseded'||r.invalidAt)return 'D';
 if(r.status==='pending')return 'C';
 return r.scope==='global'&&['profile','preference','constraint'].includes(r.category??'')&&TRUSTED.includes(r.sourceType??'')?'A':'B';
}

/** 终端兜底：纯文本输出，不依赖右侧栏是否可用。 */
export function runCommand(line       ,deps    ,ctx    )       {
 const [verb='status',...rest]=line.split(/\s+/).filter(Boolean);
 const store=deps.store,work=deps.work;
 if(verb==='status'){
  const records=store.dump();const grades                      ={A:0,B:0,C:0,D:0};
  for(const r of records)grades[grade(r)]++;
  return ['记忆 '+records.length+' 条（A'+grades.A+'/B'+grades.B+'/C'+grades.C+'/D'+grades.D+'），未决冲突 '+store.conflicts().length,
   '自动模式 '+(store.setting('autoMode')??'candidates')+'，网关待处理 '+(deps.gate?.stats()?.pending??0)+'，技能 '+(work?.list('skill',ctx).length??0)].join('\n');
 }
 if(verb==='conflicts'){
  const rows=store.conflicts();
  if(!rows.length)return '没有未决冲突。';
  return rows.slice(0,10).map((c    )=>c.id+' target='+c.targetId+' ('+c.reason+') 提案：'+String(c.proposal).slice(0,80)).join('\n');
 }
 if(verb==='skills'){
  const cards=work?.cards('',ctx)??[];
  if(!cards.length)return '还没有技能卡片。';
  return cards.slice(0,10).map((c    )=>c.id+' ['+c.stage+'] '+c.name+' — '+String(c.description??'').slice(0,60)).join('\n');
 }
 if(verb==='resolve'){
  const [id,decision='reject']=rest;
  if(!id)return '用法：/mymemory resolve <冲突id> accept|reject';
  store.resolveConflict(id,decision==='accept',ctx);
  return '冲突 '+id+' 已'+(decision==='accept'?'接受':'驳回')+'。';
 }
 if(verb==='skill'){
  const [id,stage]=rest;
  if(!id||!stage)return '用法：/mymemory skill <技能id> promote|deprecate';
  const record=work.get(id,ctx);
  work.setSkillStage(id,record.version,stage==='promote'?'verified':'deprecated',ctx);
  return '技能 '+id+' 已标记为'+(stage==='promote'?'转正':'废弃')+'。';
 }
 return '子命令：'+USAGE;
}

export function mountCommands(ctx    ,deps    ){
 try{
  ctx.inject?.(['commands'],(host    )=>{
   try{
    const dispose=host.commands.register({
     definitionId:'mymemory',
     name:'mymemory',
     description:'查看与裁决本地记忆（status / conflicts / skills / resolve / skill）',
     handler:(invocation    )=>{
      try{
       const agent=invocation?.agent;
       const context=scopeContext(agent?.session?.header?.cwd,agent?.session?.id);
       return {kind:'success',text:runCommand(String(invocation?.rawInput??''),deps,context)};
      }catch(error){return {kind:'error',text:safeError(error)};}
     },
    });
    host.effect(()=>()=>{dispose();});
   }catch{}
  });
 }catch{}
}
