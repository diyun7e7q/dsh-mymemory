import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {fail} from './safety.js';
/** 两份面向用户的人设文件：USER.md 是长期设定，STATE.md 是近期焦点。它们既是注入源也是面板的编辑对象，所以只有这一处读写。 */
export const DOC_NAMES={user:'USER.md',state:'STATE.md'}         ;
                                           
export const STATE_LIMIT=800;
                                                                                                      
function normalize(value        ){return String(value??'').replace(/\r\n/g,'\n').trim();}
export function loadDoc(dir       ,kind        ,limit       ,read                      =(file)=>readFileSync(file,'utf8'))    {
 const file=join(dir,DOC_NAMES[kind]);let text='';let missing=false;
 try{text=normalize(read(file));}catch{missing=true;}
 return {text,file,chars:text.length,missing,overLimit:limit>0&&text.length>limit,limit};
}
export function saveDoc(dir       ,kind        ,text       ,limit       )    {
 const next=normalize(text);
 if(limit>0&&next.length>limit)fail('DOC_BUDGET_EXCEEDED');
 mkdirSync(dir,{recursive:true,mode:0o700});
 writeFileSync(join(dir,DOC_NAMES[kind]),next,'utf8');
 return loadDoc(dir,kind,limit);
}
