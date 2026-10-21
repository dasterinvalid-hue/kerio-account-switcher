import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';

const origin='https://mail.example.test';
const prefix='/_kas/a/'+'a'.repeat(32);
function worker(clientUrl=origin+prefix+'/webmail/',respond=()=>new Response('ok')){
  const handlers={};
  const streamed=new WeakMap();
  class Http1Request extends Request {
    constructor(input,init){
      const isStream=init?.body instanceof ReadableStream || (init?.body===undefined&&streamed.get(input)===true);
      super(input,init);streamed.set(this,isStream);
    }
  }
  let forwarded;
  vm.runInNewContext(fs.readFileSync(new URL('../public/worker.js',import.meta.url),'utf8'),{
    URL,Headers,Request:Http1Request,
    self:{location:{origin},clients:{get:async()=>({url:clientUrl})},addEventListener:(name,fn)=>{handlers[name]=fn;}},
    // Chromium rejects upload streams over HTTP/1.x. Node's fetch does not,
    // so enforce that browser restriction explicitly in this test harness.
    fetch:async request=>{if(streamed.get(request))throw new Error('Streaming request body is unsupported over HTTP/1.x');forwarded=request;return respond(request);}
  });
  return async request=>{
    let response;
    handlers.fetch({request,clientId:'test',respondWith:promise=>{response=promise;}});
    if(response){
      const result=await response;
      // Fetch Standard, HTTP fetch: a worker's response must satisfy the
      // ORIGINAL request's redirect policy, not the internal fetch's policy.
      if(request.redirect!=='follow'&&result.redirected)throw new Error('NetworkError: followed redirect returned to navigation');
      if(request.redirect!=='manual'&&result.type==='opaqueredirect')throw new Error('NetworkError: unexpected opaque redirect');
    }
    return forwarded;
  };
}
function navigation(url,options={}){
  const request=new Request(url,{redirect:'manual',...options});
  // Navigation requests are produced by the browser, never by new Request().
  Object.defineProperty(request,'mode',{value:'navigate'});
  return request;
}
test('account navigation becomes a fetchable request without leaving its route',async()=>{
  const original=navigation(origin+prefix+'/webmail/');
  assert.throws(()=>new Request(original.url,original),/navigate/);
  const forwarded=await worker()(original);
  assert.equal(forwarded.url,original.url);
  assert.equal(forwarded.mode,'same-origin');
  assert.equal(forwarded.redirect,'manual');
  assert.equal(forwarded.headers.get('X-KAS-Worker'),'1');
});
test('Kerio login redirect is handed to the browser instead of returning a followed response',async()=>{
  const fetchRedirect=request=>request.redirect==='follow'
    ?{type:'basic',redirected:true}
    :{type:'opaqueredirect',redirected:false};
  const forwarded=await worker(origin+prefix+'/webmail/',fetchRedirect)(navigation(origin+prefix+'/webmail/'));
  assert.equal(forwarded.redirect,'manual');
});
test('recovery launcher and worker scripts bypass the mail interceptor',async()=>{
  for(const path of ['/_kas/connect?account='+'b'.repeat(32),'/_kas/start.js','/_kas/worker.js?v=5']){
    assert.equal(await worker()(navigation(origin+path)),undefined);
  }
});
test('primary mailbox navigation from the launcher cannot inherit the previous account',async()=>{
  const forwarded=await worker(origin+'/_kas/connect?account=primary')(navigation(origin+'/webmail/'));
  assert.equal(forwarded.url,origin+'/webmail/');
  assert.equal(forwarded.headers.get('X-KAS-Worker'),null);
});
test('login POST navigation preserves method, body and account prefix',async()=>{
  const forwarded=await worker()(navigation(origin+'/webmail/login/',{method:'POST',body:'test=form',headers:{'Content-Type':'application/x-www-form-urlencoded'}}));
  assert.equal(forwarded.url,origin+prefix+'/webmail/login/');
  assert.equal(forwarded.method,'POST');
  assert.equal(await forwarded.text(),'test=form');
  assert.equal(forwarded.headers.get('Content-Type'),'application/x-www-form-urlencoded');
});
test('already-prefixed login POST keeps replayable form data and the login-page referrer',async()=>{
  const login=origin+prefix+'/webmail/login/';
  const original=navigation(login+'dologin',{method:'POST',body:'test=form',referrer:login,headers:{'Content-Type':'application/x-www-form-urlencoded'}});
  const forwarded=await worker()(original);
  assert.equal(forwarded.url,original.url);
  assert.equal(forwarded.referrer,login);
  assert.equal(forwarded.redirect,'manual');
  assert.equal(await forwarded.text(),'test=form');
});
test('ordinary API requests keep credentials and token, external requests are untouched',async()=>{
  const forwarded=await worker()(new Request(origin+'/webmail/api/jsonrpc/',{method:'POST',body:'{}',credentials:'include',headers:{'X-Token':'test-token'}}));
  assert.equal(forwarded.url,origin+prefix+'/webmail/api/jsonrpc/');
  assert.equal(forwarded.credentials,'include');
  assert.equal(forwarded.headers.get('X-Token'),'test-token');
  assert.equal(await worker()(new Request('https://external.example.test/file')),undefined);
});

test('already-isolated API and resource requests bypass worker fetch ownership',async()=>{
  let networkCalls=0;
  const dispatch=worker(origin+prefix+'/webmail/',()=>{networkCalls++;return new Response('ok');});
  // Repeated account switches must not start worker-owned copies of a page's
  // long polls. Cookies/CSRF headers stay on the original browser request.
  for(let i=0;i<20;i++){
    const request=new Request(origin+prefix+'/webmail/api/jsonrpc/',{
      method:'POST',body:JSON.stringify({method:'Changes.get',params:{timeout:600}}),
      credentials:'include',headers:{'X-Token':'test-token'}
    });
    assert.equal(await dispatch(request),undefined);
    assert.equal(request.bodyUsed,false);
    assert.equal(request.headers.get('X-Token'),'test-token');
  }
  assert.equal(await dispatch(new Request(origin+prefix+'/webmail/webmail2.js')),undefined);
  assert.equal(networkCalls,0);
});
