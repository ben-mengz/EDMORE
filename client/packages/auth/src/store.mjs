import { readJson, writeJson } from '@edmore/plugin-host/storage'
export { readJson, writeJson } from '@edmore/plugin-host/storage'
import { UserStore } from '@islibaodong/dsh-login/src/users.ts'
export { SessionStore } from '@islibaodong/dsh-login/src/session.ts'
export { extractSessionToken, buildCookieHeader, buildClearCookieHeader } from '@islibaodong/dsh-login/src/auth.ts'

// Reuse dsh-login's password hashing and account operations. Serialize mutations
// and validate storage here, because upstream treats malformed storage as empty.
export class Accounts {
  constructor(path) {
    this.path = path
    this.pending = Promise.resolve()
    this.users = new UserStore({
      resolve: async () => {
        const records = await readJson(path, [])
        if (!Array.isArray(records) || records.some(u => !/^[a-zA-Z0-9_-]{1,32}$/.test(u.username) || !/^[a-f0-9]{128}$/.test(u.hash) || !/^[a-f0-9]{32}$/.test(u.salt) || typeof u.isAdmin !== 'boolean')) throw new Error('Invalid account store')
        return { value: JSON.stringify(records) }
      },
      set: async (_ref, value) => writeJson(path, JSON.parse(value)),
    }, 'EDMORE_USERS')
  }
  change(action) {
    const result = this.pending.then(() => action(this.users))
    this.pending = result.catch(() => {})
    return result
  }
}
export function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 256) throw Object.assign(new Error('Password must contain 12 to 256 characters'), { status: 400 })
}
export const pluginCatalog = [
  { id: 'edmore-model-hu', name: 'HU models', defaultEnabled: true, feature: 'hu', provider: 'llm3-hu' },
  { id: 'edmore-model-bonsai', name: 'Bonsai model', defaultEnabled: true, feature: 'bonsai', provider: 'bonsai-local' },
  { id: 'edmore-model-strata', name: 'Strata model', defaultEnabled: true, feature: 'strata', provider: 'strata-local' },
  { id: 'edmore-tango', name: 'Tango instruments', defaultEnabled: true, feature: 'tango' },
  { id: 'edmore-plan-judge', name: 'Workflow Engine', defaultEnabled: true },
  { id: 'edmore-conversation-title', name: 'Conversation titles', defaultEnabled: true },
  { id: 'edmore-wiki', name: 'Wiki memory (GPT)', defaultEnabled: true },
]
