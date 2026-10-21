import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import {randomUUID} from 'node:crypto';
const a='a'.repeat(32), b='b'.repeat(32), key='basis.kerio.accounts.v1';
function harness(entries=[],fail=false){
  const values=new Map([[key,JSON.stringify(entries)]]),events={},dom={},listeners={},ended=[],alerts=[];
  const storage={getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v)};
  const settings={itemId:'settings'},logout={itemId:'logout',text:'Выход'};
  const menu={items:{items:[settings,logout]},addCls(){},setWidth(v){this.width=v;},getWidth(){return this.el.getWidth();},insert(i,item){this.items.items.splice(i,0,item);},remove(item){this.items.items.splice(this.items.items.indexOf(item),1);},on(n,fn){listeners[n]=fn;}};
  const button={menu};let tick,navigated;
  const Ext={ComponentQuery:{query:()=>[button]},String:{htmlEncode:v=>v.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;')},Msg:{alert:(...args)=>alerts.push(args)}};
  const win={innerWidth:1000,localStorage:storage,Ext,addEventListener:(n,f)=>{events[n]=f;},removeEventListener:n=>{delete events[n];},kerio:{wm:{Constants:{loginName:'first@example.test',fullName:'First User'}}}};
  const context=vm.createContext({window:win,document:{currentScript:{dataset:{slot:'primary'}},createElement:()=>({remove(){}}),head:{appendChild(){}},addEventListener:(n,f)=>{dom[n]=f;},body:{appendChild(frame){
    const u=new URL(frame.src,'https://mail.example.test');ended.push(u.searchParams.get('account'));
    frame.contentWindow={postMessage(data){queueMicrotask(()=>events.message?.({origin:'https://mail.example.test',source:frame.contentWindow,data:{type:'kas-ended',nonce:data.nonce,ok:!fail}}));}};
    queueMicrotask(()=>events.message({origin:'https://mail.example.test',source:frame.contentWindow,data:{type:'kas-ready',nonce:u.hash.slice(1)}}));
  }}},Ext,navigator:{},location:{origin:'https://mail.example.test',pathname:'/webmail/',assign:u=>{navigated=u;},replace:u=>{navigated=u;}},setInterval:fn=>{tick=fn;return 1;},clearInterval(){},setTimeout,clearTimeout,crypto:{randomUUID}});
  for(const name of ['accounts.js','client.js'])vm.runInContext(fs.readFileSync(new URL('../public/'+name,import.meta.url),'utf8'),context);
  tick();
  return {menu,settings,button,values,events,listeners,ended,alerts,get navigated(){return navigated;},click(id,end=false){dom.click({target:{closest:selector=>selector===(end?'[data-kas-end]':'[data-kas-switch]')?{getAttribute:()=>id}:null},preventDefault(){},stopImmediatePropagation(){}});},flush:()=>new Promise(r=>setImmediate(r))};
}
test('menu has separate switch and exit buttons, preserves settings and replaces native logout',()=>{
  const h=harness([{id:b,name:'second@example.test',displayName:'<unsafe>"'}]);
  assert.equal(h.button.__basisSwitcher,true);assert.equal(h.menu.width,380);
  assert.ok(h.menu.items.items[0].html.includes('first@example.test'));
  assert.ok(h.menu.items.items[1].html.includes('&lt;unsafe&gt;&quot;'));
  assert.ok(h.menu.items.items[1].html.includes('data-kas-end="'+b+'"'));
  assert.equal(h.menu.items.items.filter(i=>i===h.settings).length,1);
  assert.equal(h.menu.items.items.filter(i=>i.itemId==='logout').length,0);
  assert.equal(h.menu.items.items.filter(i=>i.itemId==='basisLogout').length,1);
  h.listeners.beforeshow();h.listeners.beforeshow();assert.equal(h.menu.items.items.length,6);
  h.click('primary');assert.equal(h.navigated,undefined);
  h.click(b);assert.equal(h.navigated,'/_kas/a/'+b+'/webmail/');
});
test('ending another account removes its card without leaving the current mailbox',async()=>{
  const h=harness([{id:b,name:'second@example.test'}]);h.click(b,true);await h.flush();
  assert.deepEqual(h.ended,[b]);assert.equal(h.navigated,undefined);
  assert.equal(JSON.parse(h.values.get(key)).length,1);
});
test('native logout ends all old duplicates of current mailbox then opens the remaining account',async()=>{
  const h=harness([{id:a,name:'FIRST@example.test'},{id:b,name:'second@example.test'}]);
  assert.equal(JSON.parse(h.values.get(key)).length,2);
  h.menu.items.items.find(i=>i.itemId==='basisLogout').handler();await h.flush();
  assert.deepEqual(h.ended,['primary',a]);assert.equal(h.navigated,'/_kas/a/'+b+'/webmail/');
  assert.equal(JSON.parse(h.values.get(key))[0].name,'second@example.test');
});
test('last logout goes to primary login and network failure never reports a successful removal',async()=>{
  const h=harness();h.click('primary',true);await h.flush();
  assert.deepEqual(JSON.parse(h.values.get(key)),[]);assert.equal(h.navigated,'/_kas/connect?account=primary');
  const failure=harness([],true);failure.click('primary',true);await failure.flush();
  assert.equal(JSON.parse(failure.values.get(key)).length,1);assert.equal(failure.navigated,undefined);assert.equal(failure.alerts.length,1);
});
test('another tab leaving the current account redirects instead of recreating its card',()=>{
  const h=harness([{id:b,name:'second@example.test'}]);h.values.set(key,JSON.stringify([{id:b,name:'second@example.test'}]));h.events.storage({key});
  assert.equal(h.navigated,'/_kas/a/'+b+'/webmail/');assert.equal(JSON.parse(h.values.get(key)).length,1);
});
