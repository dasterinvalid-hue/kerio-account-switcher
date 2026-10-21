export const ROOT = '/_kas';
export const SLOT = /^[a-f0-9]{32}$/;
export function accountPath(slot) {
  if (!SLOT.test(slot)) throw new Error('Invalid account identifier');
  return `${ROOT}/a/${slot}`;
}
export function splitAccount(path) {
  const match = /^\/_kas\/a\/([a-f0-9]{32})(\/.*)$/.exec(path);
  return match ? {slot:match[1], path:match[2], prefix:accountPath(match[1])} : null;
}
export function mailPath(path) {
  return /^\/(?:webmail|weblib|shared|custom|plugins|integration)(?:\/|$)/.test(path) || /^\/(?:favicon\.ico|apple-touch-icon-precomposed\.png)$/.test(path);
}
export function cookiePrefix(slot) { accountPath(slot); return `KAS_${slot}_`; }
export function incomingCookies(value, slot) {
  const prefix = slot ? cookiePrefix(slot) : null;
  return (value || '').split(';').map(s=>s.trim()).filter(Boolean).flatMap(part=>{
    const at=part.indexOf('='); if(at<1)return [];
    const name=part.slice(0,at);
    if (prefix) return name.startsWith(prefix) ? [name.slice(prefix.length)+part.slice(at)] : [];
    return name.startsWith('KAS_') ? [] : [part];
  }).join('; ');
}
export function outgoingCookie(value, slot) {
  if(!slot)return value;
  const parts=value.split(';'), pair=parts.shift(), at=pair.indexOf('=');
  if(at<1)throw new Error('Invalid upstream cookie');
  // __Host- has a strict Path=/ requirement; Kerio currently does not use it.
  if(pair.startsWith('__Host-'))throw new Error('Unsupported __Host- upstream cookie');
  let path='/';
  const attributes=parts.filter(part=>{
    const attr=part.trim();
    if(/^Domain=/i.test(attr))return false;
    if(/^Path=/i.test(attr)){path=attr.slice(5);return false;}
    return true;
  });
  if(!path.startsWith('/')||/[;\r\n]/.test(path))throw new Error('Invalid cookie path');
  return cookiePrefix(slot)+pair+'; Path='+accountPath(slot)+path+attributes.map(a=>';'+a).join('');
}
export function rewriteLocation(value, slot, publicOrigin, upstreamOrigin) {
  if(!value)return value;
  const url=new URL(value,upstreamOrigin);
  const upstream=new URL(upstreamOrigin), external=new URL(publicOrigin);
  if(url.origin!==upstream.origin && url.origin!==external.origin)return value;
  return publicOrigin+(slot&&mailPath(url.pathname)?accountPath(slot):'')+url.pathname+url.search+url.hash;
}
export function contextFor(url, referer, publicOrigin) {
  const direct=splitAccount(url.pathname);
  if(direct)return {...direct,path:direct.path+url.search,direct:true};
  if(mailPath(url.pathname) && referer) {
    try {
      const ref=new URL(referer);
      const context=splitAccount(ref.pathname);
      if(ref.origin===publicOrigin && context)return {...context,path:url.pathname+url.search,direct:false};
    }catch{}
  }
  return {slot:null,prefix:'',path:url.pathname+url.search,direct:false};
}
export function injectClient(html, slot) {
  const prefix=slot?accountPath(slot):'';
  const tag=`<script src="${ROOT}/client.js?v=1" data-slot="${slot || 'primary'}"></script>`;
  let result=html.replace(/<head\b[^>]*>/i,match=>match+tag);
  // These relative script URLs in Kerio's index traverse above the account prefix.
  if(slot)result=result.replace(/(["'])\.\.\/\.\.\/shared\//g,`$1${prefix}/shared/`);
  return result;
}
