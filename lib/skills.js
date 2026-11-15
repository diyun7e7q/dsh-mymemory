import {scopeContext} from './core.js';
                                         
export function createSkillProvider(work          ){
 const summary=(r    )=>({name:r.name,description:r.description,source:'custom',provider:'mymemory',invocation:{modelInvocable:true,userInvocable:true}});
 return{name:'mymemory',async list(options    ={}){options.signal?.throwIfAborted();return work.catalog(scopeContext(options.cwd)).map(r=>({...summary(r),rank:300,locator:{id:r.id,version:r.version}}));},async get(candidate    ,options    ={}){options.signal?.throwIfAborted();try{const r=work.loadSkill(candidate.name,scopeContext(options.cwd));if(candidate.locator?.id!==r.id||candidate.locator?.version!==r.version)return undefined;return{...summary(r),content:r.body,metadata:{version:r.version,review:r.review}};}catch{return undefined;}}};
}
export function mountSkills(ctx    ,work          ){
 const state={available:false,changed:()=>{}};
 const mount=(host    )=>{if(typeof host.skills?.registerProvider!=='function')return;try{let invalidate=()=>{};const dispose=host.skills.registerProvider((control    )=>{invalidate=control.invalidate;return createSkillProvider(work);});state.available=true;state.changed=()=>invalidate();let epoch=work.store.setting('writeEpoch')??0;const timer=setInterval(()=>{try{const next=work.store.setting('writeEpoch')??0;if(next!==epoch){epoch=next;invalidate();}}catch{}},750);timer.unref?.();host.effect(()=>()=>{clearInterval(timer);dispose();state.available=false;});}catch{state.available=false;}};
 if(typeof ctx.inject==='function')ctx.inject(['skills'],mount);else if(ctx.skills)mount(ctx);
 return state;
}
