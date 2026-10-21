import test from 'node:test';
import assert from 'node:assert/strict';
import {incomingCookies,outgoingCookie,rewriteLocation,contextFor,injectClient} from '../core.mjs';
const a='a'.repeat(32),b='b'.repeat(32),origin='https://mail.example.test';
test('cookies of three concurrent accounts never cross routes',()=>{
  const cookies=`SESSION_CONNECT_WEBMAIL=primary; KAS_${a}_SESSION_CONNECT_WEBMAIL=a; KAS_${b}_SESSION_CONNECT_WEBMAIL=b; KAS_${a}_TOKEN_CONNECT_WEBMAIL=ta`;
  assert.equal(incomingCookies(cookies,a),'SESSION_CONNECT_WEBMAIL=a; TOKEN_CONNECT_WEBMAIL=ta');
  assert.equal(incomingCookies(cookies,b),'SESSION_CONNECT_WEBMAIL=b');
  assert.equal(incomingCookies(cookies,null),'SESSION_CONNECT_WEBMAIL=primary');
  assert.equal(incomingCookies('SESSION_CONNECT_WEBMAIL=primary',a),'');
});
test('cookie scope, HttpOnly, Secure, SameSite and deletion survive rewriting',()=>{
  assert.equal(outgoingCookie('SESSION_CONNECT_WEBMAIL=x; Path=/webmail/; Domain=example.test; Secure; HttpOnly; SameSite=Lax',a),`KAS_${a}_SESSION_CONNECT_WEBMAIL=x; Path=/_kas/a/${a}/webmail/; Secure; HttpOnly; SameSite=Lax`);
  assert.match(outgoingCookie('TOKEN_CONNECT_WEBMAIL=; Max-Age=0; Path=/',b),new RegExp(`Path=/_kas/a/${b}/; Max-Age=0`));
  assert.throws(()=>outgoingCookie('__Host-auth=x; Path=/; Secure',a));
});
test('redirects stay in their account; third party links are not rewritten',()=>{
  assert.equal(rewriteLocation('/webmail/login/',a,origin,origin+':1443'),origin+`/_kas/a/${a}/webmail/login/`);
  assert.equal(rewriteLocation('https://evil.test/webmail/login/',a,origin,origin+':1443'),'https://evil.test/webmail/login/');
  assert.equal(rewriteLocation('/admin/',a,origin,origin+':1443'),origin+'/admin/');
  assert.equal(rewriteLocation(origin+':1443/',a,origin,origin+':1443'),origin+'/');
  assert.equal(rewriteLocation(origin+':4040/admin/',a,origin,origin+':1443'),origin+':4040/admin/');
  assert.equal(rewriteLocation(origin+'/webmail/login/',null,'http://127.0.0.1:18741',origin),'http://127.0.0.1:18741/webmail/login/');
});
test('context comes only from explicit path or same-origin referring account',()=>{
  assert.equal(contextFor(new URL(origin+'/webmail/api/jsonrpc/'),origin+`/_kas/a/${a}/webmail/`,origin).slot,a);
  assert.equal(contextFor(new URL(origin+'/webmail/api/jsonrpc/'),'https://evil.test'+`/_kas/a/${a}/webmail/`,origin).slot,null);
  assert.equal(contextFor(new URL(origin+`/_kas/a/${b}/webmail/`),origin+`/_kas/a/${a}/webmail/`,origin).slot,b);
});
test('client is inserted before native code and relative shared assets stay inside account',()=>{
  const html=injectClient('<html><head><script src="../../shared/2fa/a.js"></script></head></html>',a);
  assert.ok(html.indexOf('/_kas/client.js')<html.indexOf('/shared/2fa/a.js'));
  assert.ok(html.includes(`src="/_kas/a/${a}/shared/2fa/a.js"`));
});
