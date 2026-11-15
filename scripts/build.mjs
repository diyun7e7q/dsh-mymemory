import {stripTypeScriptTypes} from 'node:module';
import {mkdirSync,readdirSync,readFileSync,writeFileSync} from 'node:fs';
mkdirSync(new URL('../lib/',import.meta.url),{recursive:true});
for(const name of readdirSync(new URL('../src/',import.meta.url)).filter(x=>x.endsWith('.ts'))){
  const source=readFileSync(new URL('../src/'+name,import.meta.url),'utf8');
  const js=stripTypeScriptTypes(source,{mode:'strip'}).replace(/(from\s+['"]\.\/[^'"]+)\.ts(['"])/g,'$1.js$2');
  writeFileSync(new URL('../lib/'+name.replace(/\.ts$/,'.js'),import.meta.url),js);
}
console.log('Built ESM JavaScript with Node TypeScript stripping (no type check).');
