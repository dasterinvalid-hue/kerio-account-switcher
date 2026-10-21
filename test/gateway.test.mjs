import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {createGateway,upstreamIdleTimeout} from '../server.mjs';
const a='a'.repeat(32),b='b'.repeat(32);
test('gateway outlasts the configured Kerio long poll and its client grace period',()=>{
  for(const seconds of [600,1800])assert.ok(upstreamIdleTimeout({kerioLongPollSeconds:seconds})>(seconds+60)*1000);
  assert.ok(upstreamIdleTimeout({})>660000);
  assert.throws(()=>upstreamIdleTimeout({kerioLongPollSeconds:-1}));
});
test('proxy preserves three identities, isolates logout, rejects ambiguous targets and installs bootstrap',async()=>{
  const upstream=http.createServer((req,res)=>{
    if(req.url==='/webmail/login'){res.writeHead(302,{'Set-Cookie':['SESSION_CONNECT_WEBMAIL=test; Path=/webmail/; HttpOnly; Secure','TOKEN_CONNECT_WEBMAIL=token; Path=/; Secure'],Location:'/webmail/'});return res.end();}
    if(req.url==='/webmail/'){res.writeHead(200,{'Content-Type':'text/html'});return res.end('<html><head></head><body>Mail</body></html>');}
    if(req.url==='/webmail/logout'){res.writeHead(200,{'Set-Cookie':'SESSION_CONNECT_WEBMAIL=; Path=/webmail/; Max-Age=0; Secure; HttpOnly'});return res.end('ok');}
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify({cookie:req.headers.cookie||'',token:req.headers['x-token'],path:req.url,origin:req.headers.origin,host:req.headers.host,ip:req.headers['x-forwarded-for'],proto:req.headers['x-forwarded-proto'],forwarded:req.headers.forwarded}));
  });
  upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
  // A fixed Host header is used while connecting to the OS-assigned local test port.
  const publicOrigin='http://mail.example.test';
  const proxy=createGateway({testMode:true,publicOrigin,upstreamOrigin:'http://127.0.0.1:'+upstream.address().port});
  proxy.listen(0,'127.0.0.1');await once(proxy,'listening');
  const request=(path,headers={},method='GET')=>new Promise((resolve,reject)=>{
    const req=http.request({hostname:'127.0.0.1',port:proxy.address().port,path,method,headers:{Host:'mail.example.test',...headers}},res=>{const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks).toString()}));});req.on('error',reject);req.end();
  });
  try{
    const cookies=`SESSION_CONNECT_WEBMAIL=p; KAS_${a}_SESSION_CONNECT_WEBMAIL=a; KAS_${b}_SESSION_CONNECT_WEBMAIL=b`;
    const forwarded=JSON.parse((await request('/webmail/api/jsonrpc/',{'X-Forwarded-For':'203.0.113.99','X-Forwarded-Proto':'evil',Forwarded:'for=203.0.113.99'})).body);
    assert.equal(forwarded.ip,'127.0.0.1');assert.equal(forwarded.proto,'http');assert.equal(forwarded.host,'mail.example.test');assert.equal(forwarded.forwarded,undefined);
    for(const [prefix,identity]of [['','p'],[`/_kas/a/${a}`,'a'],[`/_kas/a/${b}`,'b']]){
      const response=await request(prefix+'/webmail/api/jsonrpc/',{Cookie:cookies,'X-Token':'t',Origin:publicOrigin});
      assert.equal(response.status,200);assert.equal(JSON.parse(response.body).cookie,'SESSION_CONNECT_WEBMAIL='+identity);assert.equal(JSON.parse(response.body).token,'t');
    }
    const login=await request(`/_kas/a/${a}/webmail/login`);
    assert.equal(login.headers.location,publicOrigin+`/_kas/a/${a}/webmail/`);
    assert.ok(login.headers['set-cookie'][0].startsWith(`KAS_${a}_SESSION_CONNECT_WEBMAIL=`));
    const logout=await request(`/_kas/a/${a}/webmail/logout`);
    assert.ok(logout.headers['set-cookie'][0].startsWith(`KAS_${a}_SESSION_CONNECT_WEBMAIL=`));
    assert.ok(!logout.headers['set-cookie'].some(c=>c.includes(`KAS_${b}_`)));
    const boot=await request(`/_kas/a/${a}/webmail/`,{'Sec-Fetch-Dest':'document'});
    assert.ok(boot.body.includes('/_kas/start.js'));
    const launcher=await request('/_kas/connect?account='+a);
    assert.equal(launcher.status,200);
    assert.ok(launcher.body.includes(`data-account="${a}"`));
    assert.equal(launcher.headers['cache-control'],'no-store');
    assert.equal((await request('/_kas/connect?account=invalid')).status,400);
    const primaryLauncher=await request('/_kas/connect?account=primary');
    assert.equal(primaryLauncher.status,200);
    assert.ok(primaryLauncher.body.includes('data-account="primary"'));
    const shell=await request(`/_kas/a/${a}/webmail/`,{'Sec-Fetch-Dest':'document','X-KAS-Worker':'1'});
    assert.ok(shell.body.includes(`data-slot="${a}"`));
    const root=await request('/webmail/',{Referer:publicOrigin+`/_kas/a/${a}/webmail/`});
    assert.equal(root.status,307);assert.equal(root.headers.location,publicOrigin+`/_kas/a/${a}/webmail/`);
    for(const path of [`/_kas/a/${a}/admin/`,`/_kas/a/${a}/../${b}/webmail/`,`/_kas/a/${a}/%2e%2e/webmail/`,'/_kas/a/invalid/webmail/'])assert.equal((await request(path)).status,400);
    assert.equal((await request('/webmail/',{Host:'evil.test'})).status,400);
  }finally{await Promise.all([new Promise(r=>proxy.close(r)),new Promise(r=>upstream.close(r))]);}
});
