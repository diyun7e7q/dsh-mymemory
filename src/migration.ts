import {DatabaseSync,backup} from 'node:sqlite';
import {existsSync,mkdirSync,readdirSync,readFileSync,writeFileSync,lstatSync,realpathSync,unlinkSync,rmdirSync} from 'node:fs';
import {resolve,isAbsolute,parse,join,dirname,sep} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import type {MemoryStore} from './core.ts';import {readPointerFile,writePointer,pathsEqual} from './location.ts';import {fail} from './safety.ts';
type Options={dataDir:string;home:string;soulDir?:string;profile?:string};
function checkedDir(path:string,create=false){if(!path||!isAbsolute(path))fail('NOT_ABSOLUTE');const absolute=resolve(path);for(let p=absolute;;p=dirname(p)){if(existsSync(p)&&lstatSync(p).isSymbolicLink())fail('REPARSE_PATH_REJECTED');if(p===parse(p).root)break;}if(create)mkdirSync(absolute,{recursive:true});return realpathSync(absolute);}
const equal=pathsEqual;
function hash(file:string){return createHash('sha256').update(readFileSync(file)).digest('hex');}
export async function stageMigration(store:MemoryStore,options:Options,target:string){
 store.assertWritable();const source=checkedDir(options.dataDir);if(!target||!isAbsolute(target))fail('NOT_ABSOLUTE');const dest=resolve(target);if(equal(source,dest))fail('SAME_DIR');if(dest.toLowerCase().startsWith(source.toLowerCase()+sep)||source.toLowerCase().startsWith(dest.toLowerCase()+sep))fail('NESTED_DATA_DIR');
 if(existsSync(dest)&&readdirSync(dest).length)fail('TARGET_NOT_EMPTY');const to=checkedDir(dest,true);
 const soul=join(source,'SOUL.md');const copySoul=(!options.soulDir||equal(checkedDir(options.soulDir),source))&&existsSync(soul);
 const marker={id:randomUUID(),source,target:to,home:checkedDir(options.home,true),profile:options.profile??'desktop',ownerPid:process.pid,phase:'preparing',soulHash:copySoul?hash(soul):null,sourceEpoch:(store.setting('writeEpoch')??0)+1,createdAt:new Date().toISOString()};
 store.transaction(()=>{store.setting('writeEpoch',marker.sourceEpoch);store.setting('maintenance',marker);});
 let committed=false;
 try{
  await backup(store.db,join(to,'memory.sqlite'));
  if(copySoul)writeFileSync(join(to,'SOUL.md'),readFileSync(soul),{flag:'wx'});
  const check=new DatabaseSync(join(to,'memory.sqlite'),{readOnly:true});try{const integrity=check.prepare('PRAGMA integrity_check').get() as any;if(Object.values(integrity)[0]!=='ok')fail('BACKUP_INTEGRITY_FAILED');if((check.prepare('SELECT COUNT(*) AS n FROM records').get() as any).n!==(store.db.prepare('SELECT COUNT(*) AS n FROM records').get() as any).n)fail('BACKUP_COUNT_MISMATCH');}finally{check.close();}
  writePointer(options.home,{dataDir:to,previous:source,migrationId:marker.id,pendingCleanup:undefined},options.profile??'desktop');committed=true;
  return{movedTo:to,previous:source,restartRequired:true,oldWritesBlocked:true};
 }catch(error){if(!committed){store.releaseMaintenance(marker.id);for(const name of ['memory.sqlite','memory.sqlite-wal','memory.sqlite-shm',...(copySoul?['SOUL.md']:[])]){try{unlinkSync(join(to,name));}catch{}}}throw error;}
}
export function cleanupPrevious(store:MemoryStore,options:Options){
 const pointer=readPointerFile(options.home,options.profile??'desktop'),proof=store.setting('completedMigration');
 if(!pointer.previous||!proof||pointer.migrationId!==proof.id)fail('MIGRATION_PROOF_REQUIRED');const from=checkedDir(pointer.previous),current=checkedDir(options.dataDir);
 if(!equal(from,proof.source)||!equal(current,proof.target)||equal(from,current))fail('MIGRATION_PROOF_REQUIRED');
 const oldFile=join(from,'memory.sqlite');const old=new DatabaseSync(oldFile,{readOnly:true});try{const row=old.prepare("SELECT body FROM settings WHERE key='maintenance'").get() as any;const marker=row&&JSON.parse(row.body);if(marker?.id!==proof.id||marker?.sourceEpoch!==proof.sourceEpoch)fail('MIGRATION_PROOF_REQUIRED');}finally{old.close();}
 const soul=join(from,'SOUL.md');if(proof.soulHash&&existsSync(soul)&&hash(soul)!==proof.soulHash)fail('OLD_SOUL_CHANGED');
 const files=[...(proof.soulHash?['SOUL.md']:[]),'memory.sqlite-shm','memory.sqlite-wal','memory.sqlite'];const removed:string[]=[];
 for(const file of files){const path=join(from,file);if(!existsSync(path))continue;if(lstatSync(path).isSymbolicLink())fail('REPARSE_PATH_REJECTED');try{unlinkSync(path);removed.push(file);}catch{return{cleaned:false,removed,failed:file,retryRequired:true};}}
 try{if(!readdirSync(from).length)rmdirSync(from);}catch{}
 writePointer(options.home,{previous:undefined,migrationId:undefined,pendingCleanup:undefined},options.profile??'desktop');return{cleaned:true,removed,unrelatedFilesPreserved:true};
}
