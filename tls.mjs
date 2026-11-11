import fs from 'node:fs';
import path from 'node:path';
import tls from 'node:tls';
import {X509Certificate,createPrivateKey,createHash,randomUUID} from 'node:crypto';

// Shared by the unprivileged gateway and the Windows certificate publisher.
// Never include PEM data or OpenSSL exception messages in logs.
export function validateTlsPair(pair,hostname,now=Date.now()) {
  try {
    if(typeof pair?.cert!=='string'||typeof pair?.key!=='string')throw new Error();
    const x509=new X509Certificate(pair.cert);
    if(!x509.checkHost(hostname)||!x509.checkPrivateKey(createPrivateKey(pair.key)))throw new Error();
    if(now<Date.parse(x509.validFrom)||now>=Date.parse(x509.validTo))throw new Error();
    const options={cert:pair.cert,key:pair.key,minVersion:'TLSv1.2'};
    tls.createSecureContext(options);
    return {options,fingerprint:x509.fingerprint256,expires:x509.validTo,
      digest:createHash('sha256').update(pair.cert).update('\0').update(pair.key).digest('hex')};
  } catch { throw new Error('TLS pair is incomplete, invalid, expired, or does not match the public hostname'); }
}

export function readTlsPair(config) {
  const settings=config.tls||{};
  const pair=settings.bundlePath
    ? JSON.parse(fs.readFileSync(settings.bundlePath,'utf8').replace(/^\uFEFF/,''))
    : {cert:fs.readFileSync(settings.certPath,'utf8'),key:fs.readFileSync(settings.keyPath,'utf8')};
  return validateTlsPair(pair,new URL(config.publicOrigin).hostname);
}

export function watchTls(server,config,initial,{interval=15000,log=console.log,warn=console.error}={}) {
  let current=initial,failed=false;
  const refresh=()=>{
    try {
      const next=readTlsPair(config);
      if(next.digest!==current.digest){
        // Validate before mutating the server context. Existing sockets remain open.
        server.setSecureContext(next.options);
        current=next;
        log('TLS certificate reloaded; fingerprint='+next.fingerprint+'; expires='+next.expires);
      }
      if(failed)log('TLS certificate source is available again');
      failed=false;
      return true;
    } catch {
      if(!failed)warn('TLS reload failed; retaining the last working certificate; check the certificate sync task');
      failed=true;
      return false;
    }
  };
  const timer=setInterval(refresh,interval);timer.unref();
  server.once('close',()=>clearInterval(timer));
  return refresh;
}

export function publishTlsPair(certPath,keyPath,bundlePath,hostname) {
  const pair={version:1,cert:fs.readFileSync(certPath,'utf8'),key:fs.readFileSync(keyPath,'utf8')};
  const next=validateTlsPair(pair,hostname);
  try {
    const old=JSON.parse(fs.readFileSync(bundlePath,'utf8').replace(/^\uFEFF/,''));
    if(validateTlsPair(old,hostname).digest===next.digest)return {changed:false,fingerprint:next.fingerprint};
  } catch { /* An absent/invalid cache is replaced only by a validated pair. */ }
  // The installer creates this directory with SYSTEM/admin write and service read.
  // Both files inherit that ACL; no private key is written to a public temp folder.
  const temporary=path.join(path.dirname(bundlePath),'.active-'+randomUUID()+'.tmp');
  try {
    fs.writeFileSync(temporary,JSON.stringify(pair),{encoding:'utf8',flag:'wx',mode:0o600});
    const fd=fs.openSync(temporary,'r+');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
    fs.renameSync(temporary,bundlePath);
  } finally { if(fs.existsSync(temporary))fs.unlinkSync(temporary); }
  return {changed:true,fingerprint:next.fingerprint};
}
