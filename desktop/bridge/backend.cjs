'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {pathToFileURL} = require('node:url');
const {webcrypto} = require('node:crypto');
const {createStorage} = require('./storage.cjs');
const {readConfig} = require('./config.cjs');
function createBackend({directory=__dirname, cacheFile, configFile, openOptions=async()=>{}, changed=()=>{}, fetcher=fetch}) {
  let listener;
  const extension = path.join(directory, 'extension'), settingsURL = pathToFileURL(path.join(extension, 'options.html')).href;
  const storage = createStorage(cacheFile, changed);
  const chrome = {storage, runtime:{getURL:file=>pathToFileURL(path.join(extension,file)).href,openOptionsPage:openOptions,onMessage:{addListener:fn=>{listener=fn;}}}};
  const runtime=()=>readConfig(configFile);
  let configSignature=JSON.stringify(runtime());
  function refreshConfig(){
    const current=runtime(),signature=JSON.stringify(current);
    if(signature===configSignature)return;
    configSignature=signature;
    changed({cztSettings:{newValue:current?.settings||{input:true,output:true,titles:true,chat:true,code:true}},cztRefreshAt:{newValue:Date.now()}});
  }
  const context = vm.createContext({chrome,fetch:fetcher,URL,AbortController,TextEncoder,crypto:webcrypto,setTimeout,clearTimeout,Date,CztRuntimeConfig:runtime});
  context.self = context;
  context.importScripts = (...files) => files.forEach(file=>{
    if (!['private-config.js','scope.js','cache.js'].includes(file)) throw new Error('Unexpected background module');
    vm.runInContext(fs.readFileSync(path.join(extension,file),'utf8'),context,{filename:file});
  });
  vm.runInContext(fs.readFileSync(path.join(extension,'background.js'),'utf8'),context,{filename:'background.js'});
  function allowed(url) { return url === settingsURL || context.CztChatScope.isChatURL(url); }
  async function send(message,url) {
    if (!allowed(url)) return {ok:false,code:'FORBIDDEN',error:'不支持的翻译请求来源。'};
    refreshConfig();
    if (message?.type === 'CZT_LOCAL_GET') return {ok:true,values:{...(await storage.local.get('cztSettings')),...(runtime()?{cztSettings:runtime().settings}:{})}};
    if (message?.type === 'CZT_LOCAL_SET') {
      if (url !== settingsURL) return {ok:false,code:'FORBIDDEN',error:'只能在翻译设置页更改设置。'};
      const value = message.values;
      if (!value || Object.keys(value).some(key=>!['cztSettings','cztRefreshAt'].includes(key))) return {ok:false,code:'BAD_INPUT'};
      if (value.cztSettings && (Object.keys(value.cztSettings).some(key=>!['input','output','titles','chat','code'].includes(key)) || Object.values(value.cztSettings).some(v=>typeof v!=='boolean'))) return {ok:false,code:'BAD_INPUT'};
      if (value.cztRefreshAt !== undefined && !Number.isFinite(value.cztRefreshAt)) return {ok:false,code:'BAD_INPUT'};
      await storage.local.set(value);return {ok:true};
    }
    return new Promise(resolve=>{ if(listener(message,{url},resolve)===false)resolve({ok:false,code:'BAD_MESSAGE'}); });
  }
  return {send, allowed, settingsURL,refreshConfig};
}
module.exports={createBackend};
