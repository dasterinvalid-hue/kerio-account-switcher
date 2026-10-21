import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source=fs.readFileSync(new URL('../public/start.js',import.meta.url),'utf8');
test('switching to primary leaves the old account context without logging out',async()=>{
  let destination;
  await vm.runInNewContext(source,{
    document:{currentScript:{dataset:{account:'primary'}}},
    location:{replace:url=>{destination=url;}}
  });
  assert.equal(destination,'/webmail/');
});
test('an already-installed worker opens the account without a register/update round trip',async()=>{
  let destination;
  await vm.runInNewContext(source,{
    document:{currentScript:{dataset:{account:'e'.repeat(32)}}},
    navigator:{serviceWorker:{
      getRegistration:async()=>({active:{state:'activated',scriptURL:'https://mail.example.test/_kas/worker.js?v=4'}}),
      register:async()=>{throw new Error('Warm switch must not register again');},ready:Promise.resolve()
    }},location:{replace:url=>{destination=url;}}
  });
  assert.equal(destination,'/_kas/a/'+'e'.repeat(32)+'/webmail/');
});
test('launcher waits for the replacement worker before opening the new account',async()=>{
  const account='c'.repeat(32);
  let change,navigated;
  const installing={state:'installing',addEventListener:(_event,fn)=>{change=fn;},removeEventListener(){}};
  const done=vm.runInNewContext(source,{
    document:{currentScript:{dataset:{account}},getElementById:()=>({})},
    navigator:{serviceWorker:{ready:Promise.resolve(),register:async(url,options)=>{
      assert.equal(url,'/_kas/worker.js?v=4');assert.equal(options.updateViaCache,'none');
      return {installing};
    }}},
    location:{replace:url=>{navigated=url;}},setTimeout,clearTimeout
  });
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(navigated,undefined);
  installing.state='activated';change();await done;
  assert.equal(navigated,'/_kas/a/'+account+'/webmail/');
});
test('worker update failure stays on a readable error page instead of navigating',async()=>{
  const status={};let navigated=false;
  await vm.runInNewContext(source,{
    document:{currentScript:{dataset:{account:'d'.repeat(32)}},getElementById:()=>status},
    navigator:{serviceWorker:{register:async()=>{throw new Error('Update unavailable');}}},
    location:{replace:()=>{navigated=true;}},setTimeout,clearTimeout
  });
  assert.equal(navigated,false);
  assert.equal(status.textContent,'Update unavailable');
});
