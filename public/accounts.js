/* Registry metadata only. Never store passwords, cookies or API tokens here. */
(function(root){
  'use strict';
  const valid=id=>id==='primary'||/^[a-f0-9]{32}$/.test(id||'');
  const key=name=>String(name||'').trim().toLowerCase();
  const slots=a=>[...new Set([a.id,...(Array.isArray(a.aliases)?a.aliases:[])].filter(valid))];
  function normalize(value){
    const result=[];
    for(const raw of Array.isArray(value)?value:[]){
      if(!raw||!valid(raw.id)||typeof raw.name!=='string'||!key(raw.name)||raw.name==='Новый аккаунт')continue;
      const name=raw.name.trim().slice(0,160), existing=result.find(a=>key(a.name)===key(name));
      if(existing){existing.aliases=[...new Set([...slots(existing),...slots(raw)])].filter(id=>id!==existing.id);continue;}
      result.push({id:raw.id,name,displayName:String(raw.displayName||name).slice(0,160),aliases:slots(raw).filter(id=>id!==raw.id)});
    }
    return result.slice(0,8);
  }
  function forgetSlot(value,id){
    return normalize(value).flatMap(a=>{const remaining=slots(a).filter(s=>s!==id);return remaining.length?[{...a,id:remaining[0],aliases:remaining.slice(1)}]:[];});
  }
  function remember(value,id,name,displayName){
    const entries=forgetSlot(value,id), existing=entries.find(a=>key(a.name)===key(name));
    const entry={id,name:String(name).trim().slice(0,160),displayName:String(displayName||name).slice(0,160),aliases:existing?slots(existing):[]};
    return normalize([entry,...entries.filter(a=>a!==existing)]);
  }
  root.KerioAccountRegistry={normalize,remember,forgetSlot,slots,key};
})(typeof window==='undefined'?globalThis:window);
