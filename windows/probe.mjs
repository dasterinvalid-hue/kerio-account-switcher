import fs from 'node:fs';
import https from 'node:https';
import tls from 'node:tls';
import {X509Certificate} from 'node:crypto';

const config=JSON.parse(fs.readFileSync(process.argv[2],'utf8').replace(/^\uFEFF/,''));
const mode=process.argv[3]||'gateway';
const publicUrl=new URL(config.publicOrigin);
const cert=fs.readFileSync(config.tls.certPath),key=fs.readFileSync(config.tls.keyPath);
tls.createSecureContext({cert,key});
const x509=new X509Certificate(cert);
if(!x509.checkHost(publicUrl.hostname))throw new Error('Certificate does not cover hostname');
if(Date.now()<Date.parse(x509.validFrom)||Date.now()>Date.parse(x509.validTo))throw new Error('Certificate is outside its validity period');
async function request(port,path){return new Promise((resolve,reject)=>{
  const req=https.request({hostname:publicUrl.hostname,servername:publicUrl.hostname,port,
    lookup:(h,o,cb)=>o?.all?cb(null,[{address:'127.0.0.1',family:4}]):cb(null,'127.0.0.1',4),
    path,headers:{Host:publicUrl.host},...(config.upstreamCaPath?{ca:fs.readFileSync(config.upstreamCaPath)}:{})},res=>{
      const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve({status:res.statusCode,body:Buffer.concat(chunks).toString()}));res.on('error',reject);
    });req.setTimeout(10000,()=>req.destroy(new Error('Probe timeout')));req.on('error',reject);req.end();
});}
if(mode==='certificate')console.log('Certificate and private key: OK');
else {
  const port=mode==='upstream'?Number(new URL(config.upstreamOrigin).port)||443:config.listenPort;
  if(mode!=='upstream'){
    const health=await request(port,'/_kas/health');
    if(health.status!==200||JSON.parse(health.body).status!=='ok')throw new Error('Gateway health failed');
    const script=await request(port,'/_kas/client.js');
    if(script.status!==200||!script.body.includes('basisKerioSwitcher'))throw new Error('Client module missing');
  }
  const login=await request(port,'/webmail/login/');
  if(login.status!==200||!/\<html/i.test(login.body))throw new Error('Kerio login is unavailable: '+login.status);
  console.log(mode+' HTTPS, certificate, login page: OK');
}
