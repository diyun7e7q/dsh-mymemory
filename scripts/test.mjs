import {mkdirSync,readdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';import {join,dirname} from 'node:path';import {spawnSync} from 'node:child_process';
const root=fileURLToPath(new URL('../',import.meta.url));
// Codex's redirected Windows Temp rejects atomic rename, so the scratch dir lives next to
// the package instead of the global TEMP. It must stay OUTSIDE the git root: scopeContext
// resolves every path under one repository root to the same project, and tests that assert
// project isolation would silently see each other's records.
const temp=join(dirname(root),'.mymemory-test-tmp');mkdirSync(temp,{recursive:true});
const tests=readdirSync(join(root,'test')).filter(name=>name.endsWith('.test.mjs')).map(name=>join(root,'test',name));
const result=spawnSync(process.execPath,['--test',...tests],{cwd:root,env:{...process.env,TEMP:temp,TMP:temp},stdio:'inherit',windowsHide:true});process.exitCode=result.status??1;
