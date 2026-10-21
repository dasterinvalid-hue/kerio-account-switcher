import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {createGateway} from '../server.mjs';
const a='a'.repeat(32),b='b'.repeat(32);
test('logout revokes exactly the selected Kerio session, requires same-origin action and clears its cookies only',async()=>{
  const calls=[];
  const upstream=http.createServer((req,res)=>{
    let body='';req.on('data',v=>body+=v);req.on('end',()=>{
      calls.push({path:req.url,cookie:req.headers.cookie,token:req.headers['x-token'],encoding:req.headers['accept-encoding'],body:JSON.parse(body)});
      res.setHeader('Content-Type','application/json');
      res.end(req.headers['x-token']==='expired'?'{"error":{"code":-32001}}':req.headers['x-token']==='fail'?'{"error":{"code":-32603}}':'{"result":{}}');
    });
  });upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
  const proxy=createGateway({testMode:true,publicOrigin:'http://mail.example.test',upstreamOrigin:'http://127.0.0.1:'+upstream.address().port});
  proxy.listen(0,'127.0.0.1');await once(proxy,'listening');
  const request=(path,headers={},method='POST')=>new Promise((resolve,reject)=>{
    const req=http.request({hostname:'127.0.0.1',port:proxy.address().port,path,method,headers:{Host:'mail.example.test',Origin:'http://mail.example.test','X-KAS-Action':'logout',...headers}},res=>{let body='';res.on('data',v=>body+=v);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body}));});req.on('error',reject);req.end();
  });
  const cookie=`SESSION_CONNECT_WEBMAIL=p; TOKEN_CONNECT_WEBMAIL=pt; KAS_${a}_SESSION_CONNECT_WEBMAIL=a; KAS_${a}_TOKEN_CONNECT_WEBMAIL=at; KAS_${b}_SESSION_CONNECT_WEBMAIL=b; KAS_${b}_TOKEN_CONNECT_WEBMAIL=bt`;
  try{
    for(const [prefix,id,token]of [['','p','pt'],['/_kas/a/'+a,'a','at']]){
      const response=await request(prefix+'/webmail/_kas/session',{Cookie:cookie,'Accept-Encoding':'gzip, deflate, br',Referer:'http://mail.example.test/_kas/bridge?account='+a});
      assert.equal(response.status,200);assert.deepEqual(JSON.parse(response.body),{ok:true});
      const call=calls.at(-1);assert.equal(call.token,token);assert.equal(call.cookie,`SESSION_CONNECT_WEBMAIL=${id}; TOKEN_CONNECT_WEBMAIL=${token}`);
      assert.equal(call.path,'/webmail/api/jsonrpc/');assert.equal(call.body.method,'Session.logout');
      assert.equal(call.encoding,'identity');
      assert.equal(response.headers['set-cookie'].length,4);
      assert.ok(response.headers['set-cookie'].every(v=>!v.includes('KAS_'+b)));
      if(prefix)assert.ok(response.headers['set-cookie'].every(v=>v.startsWith('KAS_'+a+'_')&&v.includes('Path='+prefix)));
    }
    const count=calls.length;
    assert.equal((await request('/webmail/_kas/session',{Cookie:cookie,Origin:'https://evil.example'})).status,403);
    assert.equal((await request('/webmail/_kas/session',{},'GET')).status,405);
    assert.equal((await request('/webmail/_kas/session',{'X-KAS-Action':'invalid',Cookie:cookie})).status,403);
    assert.equal(calls.length,count);
    assert.equal((await request('/webmail/_kas/session')).status,200);
    assert.equal((await request('/webmail/_kas/session',{Cookie:'SESSION_CONNECT_WEBMAIL=p; TOKEN_CONNECT_WEBMAIL=expired'})).status,200);
    const fail=await request('/webmail/_kas/session',{Cookie:'SESSION_CONNECT_WEBMAIL=p; TOKEN_CONNECT_WEBMAIL=fail'});
    assert.equal(fail.status,502);assert.equal(fail.headers['set-cookie'],undefined);
    assert.equal((await request('/_kas/bridge?account=primary',{},'GET')).status,200);
    assert.equal((await request('/_kas/bridge?account=invalid',{},'GET')).status,400);
  }finally{await Promise.all([new Promise(r=>proxy.close(r)),new Promise(r=>upstream.close(r))]);}
});
