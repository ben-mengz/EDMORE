const identity=JSON.parse(document.querySelector('#wiki-identity').textContent)
// Apply the deployment's English default once; later manual choices survive.
if(localStorage.getItem('edmore-wiki-locale-default')!=='en-US') {
  localStorage.setItem('locale','en-US')
  localStorage.setItem('edmore-wiki-locale-default','en-US')
}
for(const key of Object.keys(localStorage))if(key.startsWith('weknora_')||key==='WeKnora_settings')localStorage.removeItem(key)
localStorage.setItem('weknora_token','harness-session')
localStorage.setItem('weknora_refresh_token','harness-session')
localStorage.setItem('weknora_user',JSON.stringify(identity.user))
if(identity.tenant)localStorage.setItem('weknora_tenant',JSON.stringify(identity.tenant))
localStorage.setItem('weknora_memberships',JSON.stringify(identity.memberships))
// Start at the catalog so personal and shared knowledge bases are discoverable.
location.replace('/platform/knowledge-bases')
