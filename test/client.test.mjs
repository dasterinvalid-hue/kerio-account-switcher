import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';

test('profile menu installs before first render and refresh preserves native actions',()=>{
  const values=new Map();
  const storage={getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value)};
  const settings={itemId:'settings'},logout={itemId:'logout'};
  const listeners={};
  const menu={
    items:{items:[settings,logout]},
    addCls(){},setWidth(value){this.width=value;},
    // Mirrors Kerio's ExtJS 4: unrendered menus have no el.
    getWidth(){return this.el.getWidth();},
    insert(index,item){this.items.items.splice(index,0,item);return item;},
    remove(item){this.items.items.splice(this.items.items.indexOf(item),1);},
    on(event,handler){listeners[event]=handler;}
  };
  const button={menu};
  let tick,navigated;
  const Ext={ComponentQuery:{query:()=>[button]},String:{htmlEncode:value=>value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;')},Msg:{alert(){throw new Error('Unexpected alert');}}};
  vm.runInNewContext(fs.readFileSync(new URL('../public/client.js',import.meta.url),'utf8'),{
    window:{innerWidth:1000,localStorage:storage,Ext,kerio:{wm:{Constants:{loginName:'first@example.test',fullName:'First User'}}}},
    document:{currentScript:{dataset:{slot:'primary'}},createElement:()=>({}),head:{appendChild(){}}},
    Ext,navigator:{},location:{assign:url=>{navigated=url;}},setInterval:fn=>{tick=fn;return 1;},clearInterval(){},
  });
  tick();
  assert.equal(button.__basisSwitcher,true);
  assert.equal(menu.width,380);
  assert.ok(menu.items.items[0].text.includes('first@example.test'));
  assert.ok(menu.items.items[1].text.includes('Добавить аккаунт'));
  assert.equal(menu.items.items[3],settings);
  assert.equal(menu.items.items[4],logout);
  const registry=JSON.parse(values.get('basis.kerio.accounts.v1'));
  registry.push({id:'b'.repeat(32),name:'second@example.test',displayName:'<unsafe>'});
  values.set('basis.kerio.accounts.v1',JSON.stringify(registry));
  listeners.beforeshow();listeners.beforeshow();
  assert.equal(menu.items.items.length,6);
  assert.ok(menu.items.items[1].text.includes('&lt;unsafe&gt;'));
  assert.equal(menu.items.items.filter(item=>item===logout).length,1);
  assert.ok(menu.items.items.every(item=>!item.menu));
  menu.items.items[0].handler();assert.equal(navigated,undefined);
  menu.items.items[1].handler();assert.equal(navigated,'/_kas/a/'+'b'.repeat(32)+'/webmail/');
});
