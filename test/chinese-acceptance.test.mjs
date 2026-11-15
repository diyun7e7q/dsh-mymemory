import {test} from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {MemoryStore} from '../src/core.ts';
test('fixed local Chinese retrieval set: 20 useful queries and 10 negative controls',t=>{const dir=mkdtempSync(join(tmpdir(),'chinese-acceptance-'));const s=new MemoryStore(join(dir,'m.sqlite'));t.after(()=>{s.close();rmSync(dir,{recursive:true,force:true});});const facts=['VPS每月预算上限30元','项目数据库选用SQLite','偏好简短的中文说明','本项目构建命令是npm run build','项目代号MyMemory'].map(content=>s.add({content,scope:'global',sourceType:'user_explicit'},{}));const cases=[
 [0,'VPS预算'],[0,'VPS 30元'],[0,'每月预算'],[0,'预算上限'],[0,'我的VPS预算是多少'],[0,'请问VPS每月预算上限是多少呢'],[0,'还记得我的VPS预算吗'],
 [1,'SQLite'],[1,'数据库'],[1,'本项目用什么数据库'],[1,'项目数据库选用什么'],[1,'请问数据库是什么'],
 [2,'简短中文'],[2,'我的中文偏好'],[2,'请问我偏好怎样的说明'],
 [3,'构建命令'],[3,'npm run build'],[3,'本项目的构建命令是什么'],
 [4,'MyMemory'],[4,'项目代号']];
const missed=cases.filter(([id,q])=>!s.search(q,{}).some(r=>r.id===facts[id].id)).map(([,q])=>q);assert.deepEqual(missed,[],'missed predefined natural-language queries');
for(const q of ['VPS300元','VPS40元','MyMemoryX','火星天气','晚饭吃什么','密码','Redis','SQLite预算','build 999','预算600'])assert.equal(s.search(q,{}).length,0,q);
});
