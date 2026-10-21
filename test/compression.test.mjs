import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {gzipSync,gunzipSync} from 'node:zlib';
import {createGateway} from '../server.mjs';

test('gzip preserves script bytes and private/account-specific responses keep their cache boundaries',async()=>{
  const script=Buffer.from('function example(){return "test";}\n'.repeat(1000));
  const packed=gzipSync(script);
  let shellEncoding;
  const upstream=http.createServer((req,res)=>{
    if(req.url==='/webmail/'){
      shellEncoding=req.headers['accept-encoding'];
      res.writeHead(200,{'Content-Type':'text/html'});res.end('<html><head></head></html>');return;
    }
    const headers={'Content-Type':'application/javascript','Content-Length':script.length};
    if(req.url.includes('USER_WEBMAIL'))headers['Set-Cookie']='TOKEN_CONNECT_WEBMAIL=test; Path=/';
    if(req.url.includes('private.js'))headers['Cache-Control']='no-store';
    if(req.url.includes('already.js')){headers['Content-Encoding']='gzip';headers['Content-Length']=packed.length;}
    res.writeHead(200,headers);res.end(req.url.includes('already.js')?packed:script);
  });
  upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
  const proxy=createGateway({testMode:true,publicOrigin:'http://mail.example.test',upstreamOrigin:'http://127.0.0.1:'+upstream.address().port});
  proxy.listen(0,'127.0.0.1');await once(proxy,'listening');
  const get=(path,encoding='gzip')=>new Promise((resolve,reject)=>{
    const req=http.get({hostname:'127.0.0.1',port:proxy.address().port,path,headers:{Host:'mail.example.test','Accept-Encoding':encoding}},res=>{
      const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks)}));
    });req.on('error',reject);
  });
  try{
    const staticPath='/webmail/lib/test.js?v='+'a'.repeat(32);
    const compressed=await get(staticPath);
    assert.equal(compressed.headers['content-encoding'],'gzip');
    assert.deepEqual(gunzipSync(compressed.body),script);
    assert.ok(compressed.body.length<script.length/2);
    assert.equal(compressed.headers['content-length'],undefined);
    assert.match(compressed.headers.vary,/Accept-Encoding/);
    assert.match(compressed.headers['cache-control'],/^private,.*immutable/);
    const identity=await get(staticPath,'gzip;q=0, identity');
    assert.equal(identity.headers['content-encoding'],undefined);
    assert.deepEqual(identity.body,script);
    const personal=await get('/_kas/a/'+'b'.repeat(32)+'/webmail/USER_WEBMAIL.js');
    assert.deepEqual(gunzipSync(personal.body),script);
    assert.equal(personal.headers['cache-control'],'no-store');
    assert.ok(personal.headers['set-cookie'][0].startsWith('KAS_'+'b'.repeat(32)+'_TOKEN_CONNECT_WEBMAIL='));
    const dynamic=await get('/webmail/generatedDefaults.js');
    assert.equal(dynamic.headers['cache-control'],undefined);
    assert.equal((await get('/webmail/lib/private.js')).headers['cache-control'],'no-store');
    const already=await get('/webmail/lib/already.js');
    assert.deepEqual(already.body,packed);
    const shell=await get('/webmail/');
    assert.equal(shellEncoding,'identity');
    assert.ok(shell.body.toString().includes('/_kas/client.js'));
  }finally{await Promise.all([new Promise(r=>proxy.close(r)),new Promise(r=>upstream.close(r))]);}
});
