import {mkdirSync,writeFileSync,openSync,readSync,closeSync,fstatSync,realpathSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';

/**
 * 大载荷外置。
 *
 * 上下文里最贵的东西不是记忆，是一次 rg 扫全仓的输出或者一个 200KB 的日志。
 * 超过阈值就落盘，只留指针：路径 + 体积 + 行数 + sha256 + 首尾若干行。
 * 模型据此判断值不值得按行回读，而我们省下的是每一轮都要重付的输入。
 */

export type Spill={path:string;bytes:number;lines:number;sha256:string;head:string[];tail:string[];truncated:boolean};

export function unload(dir:string,name:string,body:string,options:{threshold?:number;head?:number;tail?:number}={}):Spill|undefined{
  if(typeof body!=='string')return undefined;
  const bytes=Buffer.byteLength(body,'utf8'),threshold=options.threshold??60000;
  if(bytes<=threshold)return undefined;
  const head=options.head??20,tail=options.tail??20;
  const lines=body.split(/\r?\n/);
  const digest=createHash('sha256').update(body).digest('hex');
  const safe=(name||'output').replace(/[^A-Za-z0-9._-]+/g,'-').slice(0,60)||'output';
  const stamp=new Date().toISOString().replace(/[:.]/g,'-');
  const path=join(dir,safe+'-'+stamp+'-'+digest.slice(0,8)+'.txt');
  mkdirSync(dir,{recursive:true,mode:0o700});
  writeFileSync(path,body,{encoding:'utf8',flag:'wx',mode:0o600});
  return {path,bytes,lines:lines.length,sha256:digest,head:lines.slice(0,head),tail:lines.slice(-tail),truncated:true};
}

/**
 * 按行回读。只允许读 spill 目录内的文件：这是这条链上唯一的路径注入面，
 * 认出符号链接后再比较真实路径，别拿字符串前缀当边界。
 */
export function readSpill(dir:string,target:string,offset=0,limit=200):{path:string;lines:string[];total:number;nextOffset?:number}{
  const root=realpathSync(resolve(dir));
  const path=realpathSync(resolve(target));
  // 用平台分隔符收口，别拿字符串前缀当边界：/spillX 会骗过 /spill 的前缀判断。
  const boundary=root.endsWith('/')||root.endsWith('\\')?root:root+(process.platform==='win32'?'\\':'/');
  if(path!==root&&!path.startsWith(boundary))throw Error('SPILL_PATH_REJECTED');
  const fd=openSync(path,'r');
  try{
    const size=fstatSync(fd).size;
    if(size>32*1024*1024)throw Error('SPILL_TOO_LARGE');
    const buffer=Buffer.allocUnsafe(size);
    let read=0;
    while(read<size){const n=readSync(fd,buffer,read,size-read,read);if(!n)break;read+=n;}
    const all=buffer.subarray(0,read).toString('utf8').split(/\r?\n/);
    const start=Math.max(0,offset),end=Math.min(all.length,start+Math.max(1,limit));
    return {path,lines:all.slice(start,end),total:all.length,...(end<all.length?{nextOffset:end}:{})};
  }finally{closeSync(fd);}
}
