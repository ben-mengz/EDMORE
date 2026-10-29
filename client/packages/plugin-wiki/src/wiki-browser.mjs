import {readFile} from 'node:fs/promises'
import {join} from 'node:path'
import {readJson} from '@edmore/plugin-host/storage'

export async function wikiRoute({req,res,url,wiki,user,workers,home,relay,json,fail}) {
  if(url.pathname==='/auth/wiki-bootstrap.js'&&req.method==='GET') {
    res.writeHead(200,{'content-type':'text/javascript','cache-control':'no-store'})
    res.end(await readFile(new URL('../static/wiki-bootstrap.js',import.meta.url)));return true
  }
  const api=url.pathname.startsWith('/api/v1/')
  const asset=/^\/(platform(?:\/|$)|assets\/|images\/|tdesign-icons\/|config\.js$|favicon\.|logo\.)/.test(url.pathname)
  if(url.pathname!=='/auth/wiki/open'&&!api&&!asset)return false
  if(!wiki?.browser||!(await workers.plugins(user.username)).some(p=>p.id==='edmore-wiki'&&p.enabled))throw fail(403,'Personal Wiki is not enabled')
  const session=await wiki.browser(user.username)
  if(url.pathname==='/auth/wiki/open'&&req.method==='GET') {
    const state=await readJson(join(home,'auth/wiki',user.username+'.native.json'))
    const bootstrap={user:session.user,tenant:session.active_tenant||session.tenant,memberships:session.memberships||[],kb:state.knowledgeBases.Capabilities}
    res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store','content-security-policy':"default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'"})
    res.end('<!doctype html><html lang="en"><head><meta charset="utf-8"><title>My Wiki</title><script src="/auth/wiki-bootstrap.js" defer></script></head><body><p>Opening My Wiki...</p><script id="wiki-identity" type="application/json">'+JSON.stringify(bootstrap).replace(/</g,'\\u003c')+'</script></body></html>');return true
  }
  if(api) {
    if(url.pathname==='/api/v1/auth/refresh'&&req.method==='POST') {json(res,200,{success:true,data:{token:'harness-session',refreshToken:'harness-session'}});return true}
    if(url.pathname==='/api/v1/auth/logout'&&req.method==='POST') {json(res,200,{success:true});return true}
    // Ignore client credentials/tenant headers. Only the server-held identity
    // can reach the knowledge UI; execution and admin APIs remain inaccessible.
    const read=/^\/api\/v1\/(auth\/me|models(?:\/|$)|tenants(?:\/|$)|organizations(?:\/|$)|shared-knowledge-bases(?:\/|$)|system\/(info|settings)(?:\/|$)|initialization(?:\/|$))/.test(url.pathname)&&req.method==='GET'
    const knowledge=/^\/api\/v1\/(knowledge-bases(?:\/|$)|knowledgebase(?:\/|$)|knowledge(?:\/|$)|chunks(?:\/|$)|tags(?:\/|$)|wiki(?:\/|$)|search(?:\/|$)|retrieval(?:\/|$)|tasks(?:\/|$))/.test(url.pathname)
    if(!read&&!knowledge)throw fail(403,'This operation is not available in Harness Wiki')
  } else if(req.method!=='GET'&&req.method!=='HEAD')throw fail(405,'Read-only asset')
  await relay(req,res,wiki.settings.baseUrl+url.pathname+url.search,{Authorization:'Bearer '+session.token,'Accept-Language':req.headers['accept-language']||'en-US'})
  return true
}
