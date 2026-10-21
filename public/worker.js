'use strict';
const re=/^\/_kas\/a\/([a-f0-9]{32})(\/.*)$/;
const eligible=p=>/^\/(webmail|weblib|shared|custom|plugins|integration)(\/|$)/.test(p)||p==='/favicon.ico';
self.addEventListener('install',()=>self.skipWaiting());
self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));
self.addEventListener('fetch',event=>{
  const target=new URL(event.request.url);
  if(target.origin!==self.location.origin)return;
  if(!re.test(target.pathname)&&!eligible(target.pathname))return;
  event.respondWith((async()=>{
    let match=target.pathname.match(re);
    if(!match){
      const client=event.clientId?await self.clients.get(event.clientId):null;
      const source=client?.url||event.request.referrer;
      try{const ref=new URL(source);if(ref.origin===target.origin)match=ref.pathname.match(re);}catch{}
      if(!match)return fetch(event.request);
      target.pathname='/_kas/a/'+match[1]+target.pathname;
    }
    const headers=new Headers(event.request.headers);headers.set('X-KAS-Worker','1');
    // A browser navigation has mode="navigate", which Request's constructor
    // does not accept. Convert it before copying the request to another URL.
    const navigation=event.request.mode==='navigate';
    const prepared=new Request(event.request,{
      headers,
      mode:navigation?'same-origin':event.request.mode,
      referrer:event.request.referrer,
      referrerPolicy:event.request.referrerPolicy,
      // The browser must process navigation redirects itself. A followed
      // redirect cannot be returned to an original redirect="manual" request.
      redirect:event.request.redirect
    });
    // Copying a Request as the *init dictionary* makes its body getter a new
    // streaming upload. Chromium rejects those on HTTP/1.x, including login.
    // Preserve the original body source when the account URL is already set.
    if(target.href===event.request.url)return fetch(prepared);
    return fetch(new Request(target.href,{
      method:prepared.method,headers:prepared.headers,mode:prepared.mode,
      credentials:prepared.credentials,redirect:prepared.redirect,
      referrer:prepared.referrer,referrerPolicy:prepared.referrerPolicy,
      cache:prepared.cache,integrity:prepared.integrity,
      keepalive:prepared.keepalive,signal:prepared.signal,
      body:prepared.body?await prepared.blob():undefined
    }));
  })());
});
