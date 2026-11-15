import {test} from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {runInNewContext} from 'node:vm';

function load(t){
  let bundle;
  runInNewContext(readFileSync(new URL('../client.js',import.meta.url),'utf8'),{window:{__ModuleLoader__:{load(v){bundle=v;}}},console});
  const plugin=bundle.factory(name=>{assert.equal(name,'react');return{createElement(){},useState(){return[]},useEffect(){},useRef(){return{current:0}}};});
  const entries=[];const kinds=[];
  const slots={inject(_name,fn){fn();},register(meta){entries.push(meta.name+':'+(meta.key||meta.id||''));}};
  const sub={slots,effect(fn){fn();},sidebarRightTabs:{register(def){kinds.push(def.kind);return()=>{};}},sidebarRight:{openTab(){}}};
  // 真 cordis 的 ctx.inject 只等服务就绪；只有要右栏的那次才该受 hasSidebar 限制。
  const ctx={slots,inject(keys,cb){if(!keys.includes('sidebarRightTabs')||t.hasSidebar)cb(sub);},effect(fn){fn();}};
  plugin.apply(ctx);
  return {entries,kinds,sub};
}

test('MyMemory 同时注册设置面板、右栏驾驶舱与顶栏微章',()=>{
  const {entries,kinds,sub}=load({hasSidebar:true});
  assert.deepEqual(entries,['sidebar.right.pane.tab:dsh-mymemory/panel','conversation.session.header.actions:mymemory','settings.section:mymemory']);
  assert.deepEqual(kinds,['mymemory'],'右栏 tab 类型必须先注册，否则 openTab 会抛');
});

test('右栏服务缺失时设置面板照常出现',()=>{
  const {entries}=load({hasSidebar:false});
  assert.deepEqual(entries,['settings.section:mymemory']);
});
