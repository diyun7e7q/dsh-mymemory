import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {fail} from './safety.ts';
/** 两份面向用户的人设文件：USER.md 是长期设定，STATE.md 是近期焦点。它们既是注入源也是面板的编辑对象，所以只有这一处读写。 */
export const DOC_NAMES={user:'USER.md',state:'STATE.md'} as const;
export type DocKind=keyof typeof DOC_NAMES;
export const STATE_LIMIT=800;
export type Doc={text:string;file:string;chars:number;missing:boolean;overLimit:boolean;limit:number};
function normalize(value:unknown){return String(value??'').replace(/\r\n/g,'\n').trim();}
export function loadDoc(dir:string,kind:DocKind,limit:number,read:(file:string)=>string=(file)=>readFileSync(file,'utf8')):Doc{
 const file=join(dir,DOC_NAMES[kind]);let text='';let missing=false;
 try{text=normalize(read(file));}catch{missing=true;}
 return {text,file,chars:text.length,missing,overLimit:limit>0&&text.length>limit,limit};
}
export function saveDoc(dir:string,kind:DocKind,text:string,limit:number):Doc{
 const next=normalize(text);
 if(limit>0&&next.length>limit)fail('DOC_BUDGET_EXCEEDED');
 mkdirSync(dir,{recursive:true,mode:0o700});
 writeFileSync(join(dir,DOC_NAMES[kind]),next,'utf8');
 return loadDoc(dir,kind,limit);
}
