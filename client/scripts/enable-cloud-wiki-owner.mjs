import {join} from 'node:path'
import {Accounts,readJson,writeJson} from '../packages/auth/src/store.mjs'

const home=process.env.DSH_HOME||'/data'
const username=process.env.EDMORE_WIKI_OWNER||'zhaomeng'
const accounts=new Accounts(join(home,'auth/accounts.json'))
const owner=(await accounts.users.list()).find(user=>user.username===username&&!user.disabled)
if(!owner)throw new Error('Configured Wiki owner account is missing or disabled')
const path=join(home,'auth/users',username,'plugins.json')
const previous=await readJson(path,{})
await writeJson(path,{...previous,'edmore-wiki':true})
console.log(`Wiki enabled for ${username}; other user preferences are unchanged`)
