import { resolve } from 'node:path'

export function resolveSkillsRoot(packageRoot: string, clientRoot = process.env.EDMORE_CLIENT_ROOT): string {
  return clientRoot ? resolve(clientRoot, 'skills') : resolve(packageRoot, '..', '..', 'skills')
}
