import { beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { EdmoreWorkflow as Workflow } from '../src/index.ts'
import { SessionStateStore } from '../../session-state/src/core.ts'
export * from '../src/index.ts'

let evidence: SessionStateStore
let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'edmore-workflow-evidence-'))
  evidence = new SessionStateStore(root)
  await evidence.ready()
})
afterEach(async () => {
  await evidence.flush()
  await rm(root, { recursive: true, force: true })
})

// Production workflow tests use the same persistent evidence service as the plugin.
export class EdmoreWorkflow extends Workflow {
  constructor(...args: ConstructorParameters<typeof Workflow>) {
    args[7] ??= evidence
    super(...args)
  }
}
