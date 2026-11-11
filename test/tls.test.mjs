import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import {once} from 'node:events';
import {X509Certificate} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {validateTlsPair,readTlsPair,publishTlsPair,watchTls} from '../tls.mjs';
import {createGateway} from '../server.mjs';
import {one,two,other} from './tls-fixtures.mjs';

const hostname='mail.example.test';
function temporary(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'kas-tls-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
function source(dir,name,pair){const cert=path.join(dir,name+'.crt'),key=path.join(dir,name+'.key');fs.writeFileSync(cert,pair.cert);fs.writeFileSync(key,pair.key);return [cert,key];}
function configuration(bundlePath){return {publicOrigin:'https://'+hostname,upstreamOrigin:'https://'+hostname+':8843',tls:{bundlePath}};}
function request(port,agent=false){return new Promise((resolve,reject)=>{
  const req=https.get({host:'127.0.0.1',port,servername:hostname,ca:[one.cert,two.cert],path:'/_kas/health',headers:{Host:hostname},agent},res=>{
    const fingerprint=res.socket.getPeerX509Certificate()?.fingerprint256;
    res.resume();res.once('end',()=>resolve({status:res.statusCode,fingerprint}));
  });req.on('error',reject);req.setTimeout(3000,()=>req.destroy(new Error('test timeout')));
});}

test('TLS rejects wrong hostname, mismatched/partial key, expired and future certificates',()=>{
  assert.ok(validateTlsPair(one,hostname).fingerprint);
  for(const pair of [other,{cert:one.cert,key:two.key},{cert:one.cert,key:'unfinished'},{}])assert.throws(()=>validateTlsPair(pair,hostname));
  const x509=new X509Certificate(one.cert);
  assert.throws(()=>validateTlsPair(one,hostname,Date.parse(x509.validTo)+1));
  assert.throws(()=>validateTlsPair(one,hostname,Date.parse(x509.validFrom)-1));
});

test('publisher follows renamed files atomically and retains persistent last-good pair on failure',t=>{
  const dir=temporary(t),bundle=path.join(dir,'active.json'),config=configuration(bundle);
  const first=source(dir,'server',one);
  assert.equal(publishTlsPair(...first,bundle,hostname).changed,true);
  const before=fs.statSync(bundle).mtimeMs;
  assert.equal(publishTlsPair(...first,bundle,hostname).changed,false);
  assert.equal(fs.statSync(bundle).mtimeMs,before);
  for(const f of first)fs.unlinkSync(f);
  assert.equal(readTlsPair(config).fingerprint,validateTlsPair(one,hostname).fingerprint);
  const second=source(dir,'server2',two);
  fs.writeFileSync(second[1],one.key);
  assert.throws(()=>publishTlsPair(...second,bundle,hostname));
  assert.equal(readTlsPair(config).fingerprint,validateTlsPair(one,hostname).fingerprint);
  fs.writeFileSync(second[1],two.key);
  assert.equal(publishTlsPair(...second,bundle,hostname).changed,true);
  assert.equal(readTlsPair(config).fingerprint,validateTlsPair(two,hostname).fingerprint);
  assert.deepEqual(fs.readdirSync(dir).filter(n=>n.endsWith('.tmp')),[]);
});

test('live HTTPS keeps connections during rotation, rejects corrupt updates and restarts from persisted pair',async t=>{
  const dir=temporary(t),bundle=path.join(dir,'active.json'),config=configuration(bundle);
  const files=source(dir,'server',one);publishTlsPair(...files,bundle,hostname);
  const server=createGateway(config);
  const logs=[],warnings=[];
  const refresh=watchTls(server,config,readTlsPair(config),{interval:60000,log:s=>logs.push(s),warn:s=>warnings.push(s)});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const agent=new https.Agent({keepAlive:true,maxSockets:1});
  const port=server.address().port;
  try {
    const initial=await request(port,agent);assert.equal(initial.status,200);
    fs.unlinkSync(bundle);assert.equal(refresh(),false);assert.equal(refresh(),false);assert.equal(warnings.length,1);
    assert.equal((await request(port)).status,200);
    fs.writeFileSync(bundle,JSON.stringify({cert:two.cert,key:one.key}));assert.equal(refresh(),false);
    assert.equal((await request(port)).fingerprint,initial.fingerprint);
    const next=source(dir,'server1',two);publishTlsPair(...next,bundle,hostname);
    assert.equal(refresh(),true);
    assert.equal((await request(port)).fingerprint,validateTlsPair(two,hostname).fingerprint);
    // The pre-existing TLS socket still serves requests with its original context.
    assert.equal((await request(port,agent)).status,200);
    assert.ok(logs.some(s=>s.includes('reloaded')));
    for(const f of [...files,...next])fs.unlinkSync(f);
  } finally {agent.destroy();server.closeAllConnections();await new Promise(r=>server.close(r));}
  const restarted=createGateway(config);restarted.listen(0,'127.0.0.1');await once(restarted,'listening');
  try{assert.equal((await request(restarted.address().port)).fingerprint,validateTlsPair(two,hostname).fingerprint);}
  finally{restarted.closeAllConnections();await new Promise(r=>restarted.close(r));}
});

test('Windows sync selects Kerio active certificate, survives removed files, rejects traversal and broken XML',{skip:process.platform!=='win32'},t=>{
  const dir=temporary(t),install=path.join(dir,'module'),kerio=path.join(dir,'kerio');
  for(const sub of ['tls','windows','runtime'])fs.mkdirSync(path.join(install,sub),{recursive:true});
  fs.mkdirSync(path.join(kerio,'sslcert'),{recursive:true});
  const root=fileURLToPath(new URL('../',import.meta.url));
  for(const file of ['tls.mjs','windows/publish-certificate.mjs','windows/Sync-KerioCertificate.ps1'])fs.copyFileSync(path.join(root,file),path.join(install,file));
  fs.linkSync(process.execPath,path.join(install,'runtime','node.exe'));
  const bundle=path.join(install,'tls','active.json');
  fs.writeFileSync(path.join(install,'config.json'),JSON.stringify(configuration(bundle)));
  fs.writeFileSync(path.join(install,'install-state.json'),JSON.stringify({status:'installed',kerioPath:kerio}));
  const xml=path.join(kerio,'mailserver.cfg');
  const select=name=>fs.writeFileSync(xml,'<config><table name="Misc"><variable name="SslCertificate">'+name+'</variable></table></config>');
  const run=()=>spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(install,'windows','Sync-KerioCertificate.ps1'),'-InstallDir',install],{encoding:'utf8',timeout:20000});
  source(path.join(kerio,'sslcert'),'server',one);select('server');assert.equal(run().status,0);
  const first=fs.readFileSync(bundle,'utf8');
  select('server1');assert.equal(run().status,1);assert.equal(fs.readFileSync(bundle,'utf8'),first);
  source(path.join(kerio,'sslcert'),'server1',two);assert.equal(run().status,0);
  const second=fs.readFileSync(bundle,'utf8');assert.notEqual(second,first);
  select('../../evil');assert.equal(run().status,1);assert.equal(fs.readFileSync(bundle,'utf8'),second);
  fs.writeFileSync(xml,'<config>incomplete');assert.equal(run().status,1);assert.equal(fs.readFileSync(bundle,'utf8'),second);
});
