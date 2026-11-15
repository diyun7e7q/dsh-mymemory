import { mkdirSync, readFileSync, writeFileSync,renameSync,unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

/**
 * 数据目录指针。
 *
 * 单独存成一个小文件，而不是写回 cordis.patch.yml：改位置时不用解析 YAML，
 * 也不用知道 profile 目录长什么样；库搬走了它自己不会跟着走，所以必须放在外面。
 *
 * `pendingCleanup` 是「重启后再删」的队列：迁移当时旧库还被进程开着，
 * Windows 上删不动，只能记下来等下一次启动时旧句柄已经释放再动手。
 */
export const POINTER_FILENAME = 'location.json';
export function pathsEqual(a       ,b       ,platform=process.platform){return platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;}

/** 只删插件自己写进去的东西，不碰目录里的其它文件。 */
const OWNED_FILES = ['memory.sqlite', 'memory.sqlite-wal', 'memory.sqlite-shm', 'SOUL.md'];

                                                                                                           

export function dshHome(ctx     )         {
  const profile = typeof ctx?.get === 'function' ? ctx.get('profileContext') : undefined;
  return profile?.home ?? process.env.DSH_HOME ?? join(homedir(), '.dsh');
}

export function pointerFile(home        ,profile='desktop') {
  if(!/^[a-z0-9_-]+$/i.test(profile))throw new Error('INVALID_PROFILE');
  return join(String(home ?? '.'), 'mymemory', profile, POINTER_FILENAME);
}

export function readPointerFile(home        ,profile='desktop')          {
  try {
    const raw = JSON.parse(readFileSync(pointerFile(home,profile), 'utf8'));
    const pick = (v         ) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
    return { dataDir: pick(raw?.dataDir) ?? '', previous: pick(raw?.previous), pendingCleanup: pick(raw?.pendingCleanup),migrationId:pick(raw?.migrationId) };
  } catch {
    return { dataDir: '' };
  }
}

export function readPointer(home        ,profile='desktop')         {
  return readPointerFile(home,profile).dataDir;
}

export function writePointer(home        , patch                  ,profile='desktop') {
  const file = pointerFile(home,profile);
  const next          = { ...readPointerFile(home,profile), ...patch };
  const body                         = { dataDir: next.dataDir };
  if (next.previous) body.previous = next.previous;
  if (next.pendingCleanup) body.pendingCleanup = next.pendingCleanup;
  if(next.migrationId)body.migrationId=next.migrationId;
  mkdirSync(dirname(file), { recursive: true });
  const temp=file+'.'+process.pid+'.'+Date.now()+'.tmp';try{writeFileSync(temp, JSON.stringify(body, null, 2) + '\n', {encoding:'utf8',flag:'wx',flush:true});renameSync(temp,file);}catch(error){try{unlinkSync(temp);}catch{}throw error;}
  return file;
}

/** No automatic deletion is authorized by a stored pointer. */
export function finishCleanup(_home       ,_current       )         {return [];}
