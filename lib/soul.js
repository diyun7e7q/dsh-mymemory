import {readFileSync} from 'node:fs';
import {join} from 'node:path';

export const SOUL_FILENAME='SOUL.md';
export const SOUL_LIMIT=1600;

                                                                                          

export function loadSoul(dir    ,{limit=SOUL_LIMIT,read=readFileSync}    ={})     {
  const file=join(String(dir??'.'),SOUL_FILENAME);
  let raw    ;
  try{raw=read(file,'utf8');}catch{return {text:'',file,chars:0,missing:true,overLimit:false};}
  const text=String(raw).replace(/\r\n/g,'\n').trim();
  return {text,file,chars:text.length,missing:text.length===0,overLimit:limit>0&&text.length>limit};
}
