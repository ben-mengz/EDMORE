import { cp, mkdtemp, rm } from 'node:fs/promises'
import { join, basename } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const source = fileURLToPath(new URL('..', import.meta.url))
const temporary = await mkdtemp(join(tmpdir(), 'edmore-portable-'))
const destination = join(temporary, 'client')
async function run(command, args) {
  const child = spawn(command, args, { cwd: destination, stdio: 'inherit' })
  await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)))
  })
}
try {
  await cp(source, destination, { recursive: true,
    filter: path => !['node_modules', '.runtime', 'coverage'].includes(basename(path)),
  })
  await run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'])
  await run(process.execPath, ['tests/smoke.mjs'])
  console.log('PASS: clean installation and launch outside the SEM workspace')
} finally {
  await rm(temporary, { recursive: true, force: true })
}
