import {readFileSync} from 'node:fs';
import {join} from 'node:path';

export const SOUL_FILENAME='SOUL.md';
export const SOUL_LIMIT=1600;

export type Soul={text:string;file:string;chars:number;missing:boolean;overLimit:boolean};

export function loadSoul(dir:any,{limit=SOUL_LIMIT,read=readFileSync}:any={}):Soul{
  const file=join(String(dir??'.'),SOUL_FILENAME);
  let raw:any;
  try{raw=read(file,'utf8');}catch{return {text:'',file,chars:0,missing:true,overLimit:false};}
  const text=String(raw).replace(/\r\n/g,'\n').trim();
  return {text,file,chars:text.length,missing:text.length===0,overLimit:limit>0&&text.length>limit};
}
