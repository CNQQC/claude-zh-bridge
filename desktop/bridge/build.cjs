'use strict';
const fs=require('node:fs'),path=require('node:path');
const root=__dirname,extension=path.join(root,'extension');
const glue=`(() => {
'use strict';
const {ipcRenderer}=require('electron');
const settingPage=location.protocol==='file:' && location.pathname.endsWith('/czt-desktop/extension/options.html');
if (location.origin!=='https://claude.ai' && !settingPage) return;
const call=async message=>{const result=await ipcRenderer.invoke('czt-desktop:rpc',message);if(!result?.ok){const error=new Error(result?.error||'桌面翻译后台未响应。');error.code=result?.code;throw error;}return result;};
const listeners=[];
ipcRenderer.on('czt-desktop:settings',(_event,changes)=>listeners.forEach(fn=>fn(changes,'local')));
const chrome={runtime:{sendMessage:message=>ipcRenderer.invoke('czt-desktop:rpc',message)},storage:{local:{get:async()=> (await call({type:'CZT_LOCAL_GET'})).values,set:values=>call({type:'CZT_LOCAL_SET',values})},onChanged:{addListener:fn=>listeners.push(fn)}}};
if(settingPage){document.addEventListener('DOMContentLoaded',()=>{OPTIONS_CODE},{once:true});return;}
const styleText=STYLE_TEXT;
const style=()=>{if(document.getElementById('czt-desktop-style'))return;const el=document.createElement('style');el.id='czt-desktop-style';el.textContent=styleText;(document.head||document.documentElement).append(el);};
if(document.documentElement)style();else document.addEventListener('DOMContentLoaded',style,{once:true});
CONTENT_CODE
})();`;
const sources=['scope.js','translator.js','sidebar.js','content.js'].map(file=>fs.readFileSync(path.join(extension,file),'utf8')).join('\n');
const options=fs.readFileSync(path.join(extension,'options.js'),'utf8');
const preload=glue.replace('OPTIONS_CODE',()=>options).replace('STYLE_TEXT',()=>JSON.stringify(fs.readFileSync(path.join(extension,'content.css'),'utf8'))).replace('CONTENT_CODE',()=>sources);
fs.writeFileSync(path.join(root,'preload.cjs'),preload);
console.log('Isolated preload built; contains no provider credentials.');
