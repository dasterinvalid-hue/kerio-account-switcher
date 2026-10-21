'use strict';
(async()=>{
  const account=document.currentScript?.dataset.account;
  try{
    // This document has no account prefix, so the worker cannot inherit the
    // previous account when the browser opens the primary mailbox from here.
    if(account==='primary'){location.replace('/webmail/');return;}
    if(!('serviceWorker' in navigator))throw new Error('Браузер не поддерживает отдельные сеансы. Используйте современный Chrome, Edge или Firefox.');
    // Reuse an installed worker without a network update check on each switch.
    let registration=await navigator.serviceWorker.getRegistration?.('/_kas/');
    if(registration?.active?.state!=='activated'||!registration.active.scriptURL.endsWith('/_kas/worker.js?v=5')){
      registration=await navigator.serviceWorker.register('/_kas/worker.js?v=5',{scope:'/_kas/',updateViaCache:'none'});
    }
    const installing=registration.installing||registration.waiting;
    if(installing&&installing.state!=='activated')await new Promise((resolve,reject)=>{
      const finish=()=>{
        if(installing.state==='activated'){clearTimeout(timer);installing.removeEventListener('statechange',finish);resolve();}
        else if(installing.state==='redundant'){clearTimeout(timer);installing.removeEventListener('statechange',finish);reject(new Error('Не удалось обновить обработчик аккаунтов. Обновите эту страницу.'));}
      };
      const timer=setTimeout(()=>{installing.removeEventListener('statechange',finish);reject(new Error('Обновление обработчика аккаунтов заняло слишком много времени. Обновите эту страницу.'));},15000);
      installing.addEventListener('statechange',finish);finish();
    });
    await navigator.serviceWorker.ready;
    if(/^[a-f0-9]{32}$/.test(account||'')){location.replace('/_kas/a/'+account+'/webmail/');return;}
    if(!navigator.serviceWorker.controller)await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Не удалось запустить изоляцию сеанса. Обновите страницу.')),15000);navigator.serviceWorker.addEventListener('controllerchange',()=>{clearTimeout(timer);resolve();},{once:true});});
    location.reload();
  }catch(error){document.getElementById('status').textContent=error.message;}
})();
