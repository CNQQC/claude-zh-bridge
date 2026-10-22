'use strict';
const fs=require('node:fs');
const DEFAULT_CONTRACT='deepseek-flash|thinking-disabled|translation-json-v1';
function readConfig(file){
  if(!file)return null;
  let value;
  try{value=JSON.parse(fs.readFileSync(file,'utf8'));}catch(error){if(error.code==='ENOENT')return null;throw new Error('翻译设置文件无法读取，请在中文桥中重新保存。');}
  const provider=value.provider||{},features=value.features||{};
  const url=new URL(provider.baseURL||'https://api.deepseek.com');
  if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash)throw new Error('翻译接口地址必须是无账号信息的 HTTPS 地址。');
  const baseURL=url.href.replace(/\/+$/,'');
  const model=(provider.model||'deepseek-flash').trim();
  if(!/^[A-Za-z0-9._:/-]{1,150}$/.test(model))throw new Error('翻译模型名称无效。');
  const apiKey=typeof provider.apiKey==='string'?provider.apiKey.trim():'';
  const settings=Object.fromEntries(['input','output','titles','chat','code'].map(key=>[key,features[key]!==false]));
  const cacheNamespace=baseURL==='https://api.deepseek.com'&&model==='deepseek-flash'?DEFAULT_CONTRACT:`${baseURL}|${model}|thinking-disabled|translation-json-v1`;
  return{baseURL,model,apiKey,settings,cacheNamespace,patcherPath:typeof value.patcherPath==='string'?value.patcherPath:''};
}
module.exports={readConfig};
