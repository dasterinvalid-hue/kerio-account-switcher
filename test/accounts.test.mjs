import test from 'node:test';
import assert from 'node:assert/strict';
import '../public/accounts.js';
const r=globalThis.KerioAccountRegistry,a='a'.repeat(32),b='b'.repeat(32),c='c'.repeat(32);
test('old duplicate cards merge by normalized login while retaining session handles for logout',()=>{
  const list=r.normalize([{id:'primary',name:' User@Example.test '},{id:a,name:'user@example.test'},{id:b,name:'other@example.test'}]);
  assert.equal(list.length,2);assert.deepEqual(r.slots(list[0]),['primary',a]);
  const relogin=r.remember(list,c,'USER@example.test','User');
  assert.equal(relogin.length,2);assert.deepEqual(r.slots(relogin[0]),[c,'primary',a]);
});
test('reusing a route for a different mailbox does not leave that route on the previous card',()=>{
  const list=r.remember([{id:a,name:'one@example.test',aliases:[b]}],a,'two@example.test','Two');
  assert.equal(list.length,2);assert.deepEqual(r.slots(list[1]),[b]);
  assert.equal(r.forgetSlot(r.forgetSlot(list,a),b).length,0);
});
