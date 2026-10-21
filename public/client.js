/* BASIS Kerio Account Switcher. Contains no credentials or authentication tokens. */
(function(){
  'use strict';
  if(window.__basisKerioSwitcher)return;
  window.__basisKerioSwitcher=true;
  const script=document.currentScript;
  const slot=script?.dataset.slot;
  if(slot!=='primary'&&!/^[a-f0-9]{32}$/.test(slot||''))return;
  const prefix=slot==='primary'?'':'/_kas/a/'+slot;
  const storage=window.localStorage;
  const registryKey='basis.kerio.accounts.v1';
  const cookiePrefix='KAS_'+slot+'_';
  const eligible=path=>/^\/(webmail|weblib|shared|custom|plugins|integration)(\/|$)/.test(path)||path==='/favicon.ico';
  function mapUrl(value){
    if(!prefix)return value;
    try{const u=new URL(String(value),location.href);if(u.origin===location.origin&&eligible(u.pathname)){u.pathname=prefix+u.pathname;return u.href;}}catch{}
    return value;
  }
  if(prefix){
    let owner=Document.prototype, descriptor;
    while(owner&&!descriptor){descriptor=Object.getOwnPropertyDescriptor(owner,'cookie');owner=Object.getPrototypeOf(owner);}
    if(!descriptor?.get||!descriptor?.set)throw new Error('Cookie isolation is unavailable');
    Object.defineProperty(document,'cookie',{
      configurable:false,
      get(){return descriptor.get.call(document).split(';').map(s=>s.trim()).filter(s=>s.startsWith(cookiePrefix)).map(s=>s.slice(cookiePrefix.length)).join('; ');},
      set(value){
        const parts=String(value).split(';'), pair=parts.shift();
        if(!pair||!pair.includes('='))return;
        let path='/';const attrs=[];
        for(const part of parts){const item=part.trim();if(/^Domain=/i.test(item))continue;if(/^Path=/i.test(item)){path=item.slice(5);continue;}attrs.push(item);}
        if(!path.startsWith('/'))return;
        descriptor.set.call(document,cookiePrefix+pair+'; Path='+prefix+path+'; '+attrs.join('; '));
      }
    });
    function isolatedStorage(native){
      const keyPrefix='KAS:'+slot+':';
      const keys=()=>Object.keys(native).filter(k=>k.startsWith(keyPrefix));
      return {get length(){return keys().length;},key(i){return keys()[i]?.slice(keyPrefix.length)??null;},getItem(k){return native.getItem(keyPrefix+String(k));},setItem(k,v){native.setItem(keyPrefix+String(k),String(v));},removeItem(k){native.removeItem(keyPrefix+String(k));},clear(){keys().forEach(k=>native.removeItem(k));}};
    }
    Object.defineProperty(window,'localStorage',{get:()=>localView});
    const localView=isolatedStorage(storage);
    const sessionView=isolatedStorage(window.sessionStorage);
    Object.defineProperty(window,'sessionStorage',{get:()=>sessionView});
    const nativeFetch=window.fetch.bind(window);
    window.fetch=async(input,init)=>{
      if(input instanceof Request){
        const mapped=mapUrl(input.url);if(mapped===input.url)return nativeFetch(input,init);
        const source=new Request(input,init);
        const options={method:source.method,headers:source.headers,mode:source.mode,credentials:source.credentials,cache:source.cache,redirect:source.redirect,referrer:source.referrer,referrerPolicy:source.referrerPolicy,integrity:source.integrity,keepalive:source.keepalive,signal:source.signal};
        if(source.method!=='GET'&&source.method!=='HEAD')options.body=await source.blob();
        return nativeFetch(new Request(mapped,options));
      }
      return nativeFetch(mapUrl(input),init);
    };
    const nativeOpen=XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open=function(method,url,...args){return nativeOpen.call(this,method,mapUrl(url),...args);};
    const openWindow=window.open.bind(window);
    window.open=(url,...args)=>openWindow(url?mapUrl(url):url,...args);
    if(window.WebSocket){
      const NativeWebSocket=window.WebSocket;
      window.WebSocket=new Proxy(NativeWebSocket,{construct(Target,args){const u=new URL(args[0],location.href);if(u.host===location.host&&eligible(u.pathname)){u.pathname=prefix+u.pathname;args[0]=u.href;}return Reflect.construct(Target,args);}});
    }
    document.addEventListener('click',event=>{const a=event.target.closest?.('a[href]');if(a)a.href=mapUrl(a.href);},true);
    document.addEventListener('submit',event=>{if(event.target instanceof HTMLFormElement)event.target.action=mapUrl(event.target.action);},true);
    const submit=HTMLFormElement.prototype.submit;
    HTMLFormElement.prototype.submit=function(){this.action=mapUrl(this.action);return submit.call(this);};
  }
  function readAccounts(){
    try{const value=JSON.parse(storage.getItem(registryKey)||'[]');return Array.isArray(value)?value.filter(a=>a&&typeof a.name==='string'&&a.name.length<=160&&(a.id==='primary'||/^[a-f0-9]{32}$/.test(a.id))).slice(0,8):[];}catch{return [];}
  }
  function saveAccount(id,name,displayName){
    const entries=readAccounts().filter(a=>a.id!==id);
    entries.push({id,name:String(name).slice(0,160),displayName:String(displayName||name).slice(0,160)});
    storage.setItem(registryKey,JSON.stringify(entries.slice(-8)));
  }
  // Leave the current account's document before navigating to the primary
  // /webmail/ URL; otherwise its worker can map the navigation back to itself.
  function href(id){return id==='primary'? '/_kas/connect?account=primary':'/_kas/a/'+id+'/webmail/';}
  function addAccount(){
    if(readAccounts().length>=8){Ext.Msg.alert('Аккаунты','Можно сохранить до восьми аккаунтов в этом браузере.');return;}
    const id=[...crypto.getRandomValues(new Uint8Array(16))].map(n=>n.toString(16).padStart(2,'0')).join('');
    // Opening a new tab keeps any draft in the current account untouched.
    window.open('/_kas/connect?account='+id,'_blank','noopener');
  }
  function install(button){
    if(button.__basisSwitcher||!button.menu?.insert)return;
    const constants=window.kerio?.wm?.Constants;
    if(!constants?.loginName)return;
    try{saveAccount(slot,constants.loginName,constants.fullName);}catch{Ext.Msg.alert('Аккаунты','Браузер запретил локальное хранение списка аккаунтов.');return;}
    const accountMenu=button.menu;
    accountMenu.addCls('basis-profile-menu');
    // ExtJS 4 getWidth() dereferences el before this lazy menu is rendered.
    function sizeMenu(){accountMenu.setWidth(Math.min(380,Math.max(220,window.innerWidth-24)));}
    sizeMenu();
    const style=document.createElement('style');
    style.textContent=`
      .basis-profile-menu .basis-account{border-radius:10px;margin:4px 6px;white-space:normal!important;}
      .basis-profile-menu .basis-account .x-menu-item-link{display:flex!important;align-items:center;box-sizing:border-box;height:auto!important;min-height:72px;padding:12px!important;margin:0!important;line-height:normal!important;cursor:pointer;}
      .basis-profile-menu .basis-account .x-menu-item-text{margin:0!important;display:block!important;width:100%;min-width:0;white-space:normal!important;}
      .basis-profile-menu .basis-account .x-menu-item-icon{display:none!important;}
      .basis-profile-menu .basis-account-current{background:#edf7f8;}
      .basis-profile-menu .basis-account-current .x-menu-item-link{min-height:88px;cursor:default;}
      .basis-profile-menu .basis-account:not(.basis-account-current):hover,.basis-profile-menu .basis-account:not(.basis-account-current).x-menu-item-active{background:#f1f4f8;}
      .basis-profile-menu .basis-account .x-menu-item-link:focus-visible{outline:2px solid #147b84;outline-offset:-2px;border-radius:10px;}
      .basis-profile-menu .basis-account-row{display:flex;align-items:center;gap:12px;min-height:44px;}
      .basis-profile-menu .basis-account-avatar{display:flex;align-items:center;justify-content:center;flex:0 0 44px;height:44px;border-radius:50%;background:#169fa8;color:white;font-size:18px;line-height:1;}
      .basis-profile-menu .basis-account-copy{display:block;min-width:0;flex:1;}
      .basis-profile-menu .basis-account-name{display:block;white-space:normal;overflow-wrap:anywhere;font-size:14px;line-height:20px;color:#202124;}
      .basis-profile-menu .basis-account-email{display:block;white-space:normal;overflow-wrap:anywhere;font-size:13px;line-height:18px;color:#5f6368;margin-top:3px;}
      .basis-profile-menu .basis-account-status{display:block;font-size:11px;line-height:16px;color:#147b84;margin-bottom:3px;}
      .basis-profile-menu .basis-account-check{color:#16808a;font-size:16px;flex:0 0 16px;}
      .basis-profile-menu .basis-account-add .x-menu-item-link{height:auto!important;min-height:42px;box-sizing:border-box;padding:10px 18px!important;cursor:pointer;}
      .basis-profile-menu .basis-account-add .x-menu-item-text{color:#147b84;font-size:13px;}
    `;
    document.head.appendChild(style);
    const encode=value=>Ext.String.htmlEncode(String(value));
    function accountLabel(account){
      const name=typeof account.displayName==='string'?account.displayName:account.name;
      const initials=name.trim().split(/\s+/).slice(0,2).map(part=>Array.from(part)[0]||'').join('').toUpperCase();
      return '<span class="basis-account-row"><span class="basis-account-avatar" aria-hidden="true">'+encode(initials)+'</span><span class="basis-account-copy">'+(account.id===slot?'<span class="basis-account-status">Текущий аккаунт</span>':'')+'<span class="basis-account-name">'+encode(name)+'</span><span class="basis-account-email">'+encode(account.name)+'</span></span>'+(account.id===slot?'<span class="basis-account-check" aria-hidden="true">✓</span>':'')+'</span>';
    }
    function refresh(){
      sizeMenu();
      for(const item of accountMenu.items.items.slice())if(item.basisAccountEntry)accountMenu.remove(item,true);
      let index=0;
      const accounts=readAccounts().filter(a=>a.name!=='Новый аккаунт');
      accounts.sort((a,b)=>Number(b.id===slot)-Number(a.id===slot));
      for(const account of accounts){
        accountMenu.insert(index++,{basisAccountEntry:true,text:accountLabel(account),cls:'basis-account'+(account.id===slot?' basis-account-current':''),handler:()=>{if(account.id!==slot)location.assign(href(account.id));}});
      }
      accountMenu.insert(index++,{basisAccountEntry:true,text:'＋ Добавить аккаунт',cls:'basis-account-add',handler:addAccount});
      accountMenu.insert(index,{xtype:'menuseparator',basisAccountEntry:true});
    }
    accountMenu.on('beforeshow',refresh);
    refresh();
    button.__basisSwitcher=true;
    // Refresh an older worker even when its failed navigation cannot load start.js.
    if(navigator.serviceWorker)navigator.serviceWorker.getRegistration('/_kas/').then(r=>r?.update()).catch(()=>{});
  }
  let attempts=0;
  const timer=setInterval(()=>{
    attempts++;
    const button=window.Ext?.ComponentQuery?.query('#userMenu')?.[0];
    if(button){install(button);if(button.__basisSwitcher)clearInterval(timer);}
    if(attempts>240)clearInterval(timer);
  },250);
})();
