import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import {createGzip} from 'node:zlib';
import {fileURLToPath} from 'node:url';
import {ROOT,SLOT,contextFor,mailPath,incomingCookies,outgoingCookie,rewriteLocation,injectClient} from './core.mjs';

const directory=fileURLToPath(new URL('.',import.meta.url));
const assets=new Map(['accounts.js','bridge.js','client.js','worker.js','start.js'].map(name=>[`${ROOT}/${name}`,fs.readFileSync(directory+'public/'+name)]));
const hopHeaders=['connection','keep-alive','proxy-authenticate','proxy-authorization','te','trailer','transfer-encoding','upgrade'];
function stripHop(headers){const out={...headers};for(const h of (headers.connection||'').split(','))delete out[h.trim().toLowerCase()];for(const h of hopHeaders)delete out[h];return out;}
function respond(res,status,body,type='text/plain; charset=utf-8',extra={}){res.writeHead(status,{'Content-Type':type,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...extra});res.end(body);}
function isShellPath(path,slot){return path==='/webmail/'||path==='/webmail/index.html'||path.startsWith('/webmail/login');}
function staticAsset(path){
  return /^\/(?:webmail\/lib|weblib|shared\/(?:2fa|ms_graph))\/.+\.(?:js|css|png|gif|jpe?g|svg|woff2?|ttf|ico)$/i.test(path)
    || /^\/webmail\/webmail[23](?:color-[a-f0-9]{6})?(?:-dark)?\.(?:js|css)$/i.test(path);
}
function acceptsGzip(value){
  return (value||'').split(',').some(part=>{
    const [name,...params]=part.trim().toLowerCase().split(';');
    const quality=params.find(p=>p.trim().startsWith('q='));
    return name==='gzip'&&(!quality||Number(quality.trim().slice(2))>0);
  });
}

export function upstreamIdleTimeout(config){
  const longPollSeconds=config.kerioLongPollSeconds??600;
  if(!Number.isFinite(longPollSeconds)||longPollSeconds<0)throw new Error('Invalid Kerio long-poll timeout');
  // Kerio waits LongPollTimeout seconds; its client allows another minute.
  // The gateway must not expire a healthy poll before either of those limits.
  return Math.max(180000,longPollSeconds*1000+120000);
}

export function createGateway(config) {
  const publicUrl=new URL(config.publicOrigin), upstream=new URL(config.upstreamOrigin);
  if(!['https:','http:'].includes(upstream.protocol))throw new Error('Unsupported upstream protocol');
  if(!config.testMode && (publicUrl.protocol!=='https:'||upstream.protocol!=='https:'))throw new Error('Production requires TLS on both sides');
  const publicOrigin=publicUrl.origin;
  const idleTimeout=upstreamIdleTimeout(config);
  const transport=upstream.protocol==='https:'?https:http;
  // Long polls must not consume a small global socket pool and queue all users.
  const agent=upstream.protocol==='https:' ? new https.Agent({keepAlive:true,maxSockets:Infinity,maxFreeSockets:32}) : new http.Agent({keepAlive:true});
  function options(req,context,upgrade=false){
    const headers=stripHop(req.headers);
    headers.host=publicUrl.host;
    // Only HTML shells need uncompressed bytes for client injection.
    if(isShellPath(context.path.split('?')[0],context.slot))headers['accept-encoding']='identity';
    delete headers['x-kas-worker'];delete headers['forwarded'];
    // Never trust client-supplied proxy headers. Kerio trusts only our loopback peer.
    headers['x-forwarded-for']=(req.socket.remoteAddress||'').replace(/^::ffff:/,'');
    headers['x-forwarded-proto']=publicUrl.protocol.slice(0,-1);
    headers['x-forwarded-host']=publicUrl.host;
    headers.cookie=incomingCookies(req.headers.cookie,context.slot);
    if(!headers.cookie)delete headers.cookie;
    if(headers.referer){try{const u=new URL(headers.referer);if(u.origin===publicOrigin){const c=contextFor(u,null,publicOrigin);headers.referer=publicOrigin+c.path;}}catch{delete headers.referer;}}
    if(upgrade){headers.connection='Upgrade';headers.upgrade=req.headers.upgrade;}
    return {protocol:upstream.protocol,hostname:upstream.hostname,port:upstream.port || (upstream.protocol==='https:'?443:80),servername:upstream.hostname,method:req.method,path:context.path,headers,agent,
      ...(config.connectAddress?{lookup:(_host,_options,callback)=>{if(_options?.all)callback(null,[{address:config.connectAddress,family:4}]);else callback(null,config.connectAddress,4);}}:{}),
      ...(config.upstreamCaPath?{ca:fs.readFileSync(config.upstreamCaPath)}:{})};
  }
  function parse(req){
    if(req.headers.host!==publicUrl.host)throw new Error('Host mismatch');
    // Reject absolute-form requests and dot traversal instead of normalising into another account.
    if(!req.url.startsWith('/')||req.url.startsWith('//')||/%(?:2f|5c|2e)/i.test(req.url.split('?')[0])||req.url.split('?')[0].split('/').some(s=>s==='.'||s==='..')||req.url.includes('\\'))throw new Error('Invalid target');
    const url=new URL(req.url,publicOrigin), context=contextFor(url,req.headers.referer,publicOrigin);
    if(context.slot&&!mailPath(context.path.split('?')[0]))throw new Error('Unsupported account route');
    if(url.pathname.startsWith(ROOT+'/a/')&&!context.slot)throw new Error('Invalid account route');
    return {url,context};
  }
  const handler=(req,res)=>{
    let url,context;try{({url,context}=parse(req));}catch{return respond(res,400,'Invalid request');}
    if(url.pathname===ROOT+'/health')return respond(res,200,JSON.stringify({status:'ok',version:'1.0.2'}),'application/json');
    if(url.pathname===ROOT+'/bridge'){
      const account=url.searchParams.get('account');
      if(req.method!=='GET')return respond(res,405,'Method not allowed');
      if(account!=='primary'&&!SLOT.test(account||''))return respond(res,400,'Invalid account identifier');
      return respond(res,200,'<!doctype html><html><meta charset="utf-8"><title>Выход из аккаунта</title><script src="/_kas/bridge.js" data-account="'+account+'"></script></html>','text/html; charset=utf-8',{'Content-Security-Policy':"default-src 'none'; script-src 'self'; connect-src 'self'; frame-ancestors 'self'; base-uri 'none'"});
    }
    if(context.path.split('?')[0]==='/webmail/_kas/session'){
      if(req.method!=='POST')return respond(res,405,'Method not allowed');
      if(req.headers.origin!==publicOrigin||req.headers['x-kas-action']!=='logout')return respond(res,403,'Invalid session action');
      const cookies=incomingCookies(req.headers.cookie,context.slot);
      const pairs=new Map(cookies.split(';').map(s=>s.trim()).filter(Boolean).map(s=>{const p=s.indexOf('=');return [s.slice(0,p),s.slice(p+1)];}));
      const complete=()=>{
        const cleared=[];
        for(const name of ['SESSION_CONNECT_WEBMAIL','TOKEN_CONNECT_WEBMAIL'])for(const path of ['/','/webmail/']){
          cleared.push(outgoingCookie(name+'=; Path='+path+'; Max-Age=0; HttpOnly; SameSite=Lax'+(publicUrl.protocol==='https:'?'; Secure':''),context.slot));
        }
        respond(res,200,'{"ok":true}','application/json',{'Set-Cookie':cleared});
      };
      if(!pairs.get('SESSION_CONNECT_WEBMAIL')){req.resume();return complete();}
      if(!pairs.get('TOKEN_CONNECT_WEBMAIL')){req.resume();return respond(res,409,'{"ok":false}','application/json');}
      const opts=options(req,{...context,path:'/webmail/api/jsonrpc/'});
      opts.headers['content-type']='application/json';opts.headers['x-token']=pairs.get('TOKEN_CONNECT_WEBMAIL');
      // This internal response is parsed here, not by the browser's decoder.
      opts.headers['accept-encoding']='identity';
      delete opts.headers['content-length'];delete opts.headers['x-kas-action'];
      const logout=transport.request(opts,response=>{
        let body='';response.setEncoding('utf8');
        response.on('data',chunk=>{body+=chunk;if(body.length>65536)response.destroy();});
        response.on('error',()=>{if(!res.writableEnded)respond(res,502,'{"ok":false}','application/json');});
        response.on('end',()=>{try{const value=JSON.parse(body);if(response.statusCode===200&&(('result' in value&&!value.error)||value.error?.code===-32001))return complete();}catch{}respond(res,502,'{"ok":false}','application/json');});
      });
      logout.setTimeout(10000,()=>logout.destroy());
      logout.on('error',()=>{if(!res.writableEnded)respond(res,502,'{"ok":false}','application/json');});
      res.on('close',()=>{if(!res.writableEnded)logout.destroy();});
      req.resume();logout.end(JSON.stringify({jsonrpc:'2.0',id:1,method:'Session.logout',params:{}}));return;
    }
    if(url.pathname===ROOT+'/connect'){
      const account=url.searchParams.get('account');
      if(req.method!=='GET')return respond(res,405,'Method not allowed');
      if(account!=='primary'&&!SLOT.test(account||''))return respond(res,400,'Invalid account identifier');
      // This launcher is outside the worker's intercepted mail paths, so even
      // an older broken worker cannot prevent its replacement from loading.
      return respond(res,200,'<!doctype html><html lang="ru"><meta charset="utf-8"><title>Переключение аккаунта — Kerio</title><body><p id="status">Открываем аккаунт…</p><script src="/_kas/start.js" data-account="'+account+'"></script></body></html>','text/html; charset=utf-8',{'Content-Security-Policy':"default-src 'none'; script-src 'self'; worker-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'"});
    }
    if(assets.has(url.pathname)){
      if(req.method!=='GET')return respond(res,405,'Method not allowed');
      return respond(res,200,assets.get(url.pathname),'text/javascript; charset=utf-8',url.pathname.endsWith('/worker.js')?{'Service-Worker-Allowed':ROOT+'/'}:{});
    }
    if(context.slot&&!context.direct){
      return respond(res,307,'Continue in the selected account','text/plain; charset=utf-8',{Location:publicOrigin+context.prefix+context.path});
    }
    if(context.slot && req.method==='GET' && req.headers['sec-fetch-dest']==='document' && req.headers['x-kas-worker']!=='1') {
      return respond(res,200,'<!doctype html><html lang="ru"><meta charset="utf-8"><title>Вход в аккаунт — Kerio</title><body><p id="status">Подготавливаем отдельный сеанс…</p><script src="/_kas/start.js"></script></body></html>','text/html; charset=utf-8',{'Content-Security-Policy':"default-src 'none'; script-src 'self'; worker-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'"});
    }
    const requestStarted=Date.now();
    const upstreamRequest=transport.request(options(req,context),response=>{
      let headers=stripHop(response.headers);
      try {
        if(headers['set-cookie'])headers['set-cookie']=headers['set-cookie'].map(c=>outgoingCookie(c,context.slot));
        if(headers.location)headers.location=rewriteLocation(headers.location,context.slot,publicOrigin,upstream.origin);
      }catch{response.destroy();return respond(res,502,'Upstream cookie is incompatible with account isolation');}
      const path=context.path.split('?')[0];
      const isHtml=(headers['content-type']||'').includes('text/html');
      const shell=isHtml && isShellPath(path,context.slot);
      if(shell && response.statusCode===200){
        const chunks=[];let size=0;
        response.on('data',chunk=>{size+=chunk.length;if(size>2*1024*1024){response.destroy();if(!res.headersSent)respond(res,502,'Upstream HTML too large');}else chunks.push(chunk);});
        response.on('end',()=>{if(res.writableEnded)return;const body=injectClient(Buffer.concat(chunks).toString('utf8'),context.slot);delete headers['content-length'];delete headers.etag;delete headers['content-encoding'];headers['cache-control']='no-store';res.writeHead(response.statusCode,headers);res.end(body);});
        response.on('error',()=>{if(!res.headersSent)respond(res,502,'Upstream response interrupted');else res.destroy();});
      }else{
        // Never cache authenticated API responses or responses containing session cookies.
        if(headers['set-cookie']||path.includes('/api/')||path.includes('/login'))headers['cache-control']='no-store';
        if(response.statusCode===200&&!headers['set-cookie']&&!headers['cache-control']&&staticAsset(path)){
          headers['cache-control']=/^[a-f0-9]{32}$/i.test(new URL(context.path,publicOrigin).searchParams.get('v')||'')?'private, max-age=31536000, immutable':'private, max-age=3600';
        }
        const scriptOrStyle=/^(?:application\/(?:javascript|x-javascript)|text\/(?:javascript|css))(?:;|$)/i.test(headers['content-type']||'');
        const compress=req.method==='GET'&&response.statusCode===200&&scriptOrStyle&&!headers['content-encoding']&&acceptsGzip(req.headers['accept-encoding'])&&!/\bno-transform\b/i.test(headers['cache-control']||'');
        if(compress){
          headers['content-encoding']='gzip';delete headers['content-length'];
          if(headers.etag&&!headers.etag.startsWith('W/'))headers.etag='W/'+headers.etag;
          const vary=(headers.vary||'').split(',').map(s=>s.trim()).filter(Boolean);
          if(!vary.some(s=>s.toLowerCase()==='accept-encoding'||s==='*'))vary.push('Accept-Encoding');
          headers.vary=vary.join(', ');
          const gzip=createGzip({level:4});
          gzip.on('error',()=>res.destroy());response.on('error',()=>gzip.destroy());
          res.on('close',()=>{if(!res.writableEnded){response.destroy();gzip.destroy();}});
          res.writeHead(response.statusCode,headers);response.pipe(gzip).pipe(res);
        }else{res.writeHead(response.statusCode,headers);response.pipe(res);}
        response.on('error',()=>res.destroy());
      }
    });
    // ActiveSync and other native HTTPS protocols can wait longer than webmail.
    const requestTimeout=mailPath(context.path.split('?')[0])?idleTimeout:Math.max(idleTimeout,3600000);
    upstreamRequest.setTimeout(requestTimeout,()=>upstreamRequest.destroy(Object.assign(new Error('Upstream timeout'),{code:'UPSTREAM_IDLE_TIMEOUT'})));
    upstreamRequest.on('error',error=>{
      if(req.aborted||res.destroyed)return;
      // No URLs, query strings, request bodies, credentials or server messages.
      const info={time:new Date().toISOString(),method:req.method,kind:context.path.split('?')[0]==='/webmail/api/jsonrpc/'?'rpc':'other',code:/^[A-Z0-9_]+$/.test(error.code||'')?error.code:'UPSTREAM_ERROR',elapsedMs:Date.now()-requestStarted};
      if(typeof config.onUpstreamError==='function')config.onUpstreamError(info);
      else console.error('Kerio upstream request failed',JSON.stringify(info));
      if(!res.headersSent)respond(res,502,'Kerio is temporarily unavailable');else res.destroy();
    });
    req.on('aborted',()=>upstreamRequest.destroy());
    res.on('close',()=>{if(!res.writableEnded)upstreamRequest.destroy();});
    req.pipe(upstreamRequest);
  };
  const server=config.testMode ? http.createServer(handler) : https.createServer({key:fs.readFileSync(config.tls.keyPath),cert:fs.readFileSync(config.tls.certPath),minVersion:'TLSv1.2'},handler);
  if(!config.testMode){
    // Read the pair together. A partial certificate renewal keeps the last valid pair.
    let lastPair=fs.readFileSync(config.tls.certPath,'utf8')+fs.readFileSync(config.tls.keyPath,'utf8');
    let warned=false;
    const refreshTls=()=>{try{
      const cert=fs.readFileSync(config.tls.certPath,'utf8'),key=fs.readFileSync(config.tls.keyPath,'utf8');
      if(cert+key===lastPair)return;
      server.setSecureContext({cert,key,minVersion:'TLSv1.2'});lastPair=cert+key;warned=false;
      console.log('TLS certificate reloaded');
    }catch{if(!warned)console.error('TLS reload failed; retaining previous certificate');warned=true;}};
    const tlsTimer=setInterval(refreshTls,15000);tlsTimer.unref();
    server.on('close',()=>clearInterval(tlsTimer));
  }
  server.headersTimeout=30000;server.requestTimeout=300000;
  server.on('upgrade',(req,client,head)=>{
    let context;try{({context}=parse(req));}catch{client.end('HTTP/1.1 400 Bad Request\r\n\r\n');return;}
    const proxy=transport.request(options(req,context,true));
    proxy.on('upgrade',(response,socket,upstreamHead)=>{
      let lines=`HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\n`;
      try{for(let i=0;i<response.rawHeaders.length;i+=2){let value=response.rawHeaders[i+1];if(response.rawHeaders[i].toLowerCase()==='set-cookie')value=outgoingCookie(value,context.slot);lines+=response.rawHeaders[i]+': '+value+'\r\n';}}
      catch{socket.destroy();client.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');return;}
      client.write(lines+'\r\n');if(upstreamHead.length)client.write(upstreamHead);if(head.length)socket.write(head);client.pipe(socket).pipe(client);
      socket.on('error',()=>client.destroy());client.on('error',()=>socket.destroy());client.on('close',()=>socket.destroy());
    });
    proxy.on('response',response=>{client.end(`HTTP/1.1 ${response.statusCode} Upgrade Failed\r\nConnection: close\r\n\r\n`);response.resume();});
    proxy.on('error',()=>client.destroy());client.on('error',()=>proxy.destroy());proxy.end();
  });
  server.on('close',()=>agent.destroy());
  return server;
}
if(process.argv[1] && fileURLToPath(import.meta.url)===fileURLToPath(new URL('file:///'+process.argv[1].replaceAll('\\','/')))) {
  const config=JSON.parse(fs.readFileSync(process.argv[2] || directory+'config.json','utf8').replace(/^\uFEFF/,''));
  const server=createGateway(config);
  server.listen(config.listenPort,config.listenAddress||'127.0.0.1',()=>console.log(`Kerio account gateway listening on ${config.listenAddress||'127.0.0.1'}:${config.listenPort}`));
  for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>server.close(()=>process.exit(0)));
}
