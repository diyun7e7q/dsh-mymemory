import {mkdirSync,openSync,writeSync,closeSync,readFileSync,unlinkSync} from 'node:fs';
import {dirname} from 'node:path';

/**
 * 跨进程写锁。
 *
 * 网关可能被多个 DSH 实例（desktop / web / headless / acp）同时挂载到同一个
 * 数据目录，而 SQLite 只保证单条语句原子，不保证「读候选 → 判定 → 落盘」整段。
 * 宿主也没有优雅退出保证（Electron 被强杀、headless 超时被 kill），所以锁
 * 必须自带失效：持锁进程已经不在，或超过 ttl，就允许下一个接管。
 */
export class FileLock {
  path:string; ttlMs:number; held=false;
  constructor(path:string,ttlMs=60000){this.path=path;this.ttlMs=ttlMs;}

  /** 只有确认过期才允许接管，避免删掉别人刚建好的锁。 */
  private stale():boolean{
    let raw:string;
    try{raw=readFileSync(this.path,'utf8');}catch{return true;}
    let meta:any={};
    try{meta=JSON.parse(raw)??{};}catch{/* 半截写入的锁等于没写 */}
    if(Number.isInteger(meta.pid)&&meta.pid!==process.pid){
      // Windows 上 process.kill(pid,0) 对已退出进程抛 ESRCH，对无权限进程抛 EPERM。
      // 只有 ESRCH 能证明它死了；EPERM 说明还活着，宁可让出。
      try{process.kill(meta.pid,0);}catch(error:any){if(error?.code==='ESRCH')return true;else return false;}
    }
    const age=Date.now()-Number(meta.at??0);
    return !(Number.isFinite(age)&&age>=0&&age<this.ttlMs);
  }

  acquire():boolean{
    if(this.held)return true;
    try{mkdirSync(dirname(this.path),{recursive:true,mode:0o700});}catch{return false;}
    for(let attempt=0;attempt<2;attempt++){
      try{
        const fd=openSync(this.path,'wx',0o600);
        try{writeSync(fd,JSON.stringify({pid:process.pid,at:Date.now()}));}finally{closeSync(fd);}
        this.held=true;return true;
      }catch(error:any){
        if(error?.code!=='EEXIST')return false;
        if(!this.stale())return false;
        try{unlinkSync(this.path);}catch{return false;}
      }
    }
    return false;
  }

  release(){
    if(!this.held)return;
    this.held=false;
    try{const meta=JSON.parse(readFileSync(this.path,'utf8'));if(meta?.pid!==process.pid)return;unlinkSync(this.path);}catch{}
  }
}
