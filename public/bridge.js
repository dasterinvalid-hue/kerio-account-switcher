'use strict';
// This document is outside account paths, so even an older worker cannot
// rewrite an explicit primary-account request into the current account.
const account=document.currentScript.dataset.account;
const nonce=location.hash.slice(1);
let used=false;
addEventListener('message',async event=>{
  if(used||event.source!==parent||event.origin!==location.origin||event.data?.nonce!==nonce||event.data?.type!=='kas-end')return;
  used=true;
  try{
    const prefix=account==='primary'?'':'/_kas/a/'+account;
    const response=await fetch(prefix+'/webmail/_kas/session',{method:'POST',credentials:'same-origin',headers:{'X-KAS-Action':'logout'},signal:AbortSignal.timeout(15000)});
    const result=await response.json();
    parent.postMessage({type:'kas-ended',nonce,ok:response.ok&&result.ok===true},location.origin);
  }catch{parent.postMessage({type:'kas-ended',nonce,ok:false},location.origin);}
});
parent.postMessage({type:'kas-ready',nonce},location.origin);
