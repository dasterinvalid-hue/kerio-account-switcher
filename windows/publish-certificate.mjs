import fs from 'node:fs';
import path from 'node:path';
import {publishTlsPair} from '../tls.mjs';

try {
  const [installDir,kerioPath,name]=process.argv.slice(2);
  if(!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(name||''))throw new Error();
  const config=JSON.parse(fs.readFileSync(path.join(installDir,'config.json'),'utf8').replace(/^\uFEFF/,''));
  const bundle=path.join(installDir,'tls','active.json');
  if(path.resolve(config.tls.bundlePath)!==path.resolve(bundle))throw new Error();
  const result=publishTlsPair(path.join(kerioPath,'sslcert',name+'.crt'),path.join(kerioPath,'sslcert',name+'.key'),bundle,new URL(config.publicOrigin).hostname);
  if(result.changed)console.log('TLS snapshot updated; fingerprint='+result.fingerprint);
} catch {
  console.error('TLS sync failed: active Kerio certificate/key could not be validated or published; previous snapshot retained');
  process.exitCode=1;
}
