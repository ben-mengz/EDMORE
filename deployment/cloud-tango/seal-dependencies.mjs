import { execFileSync } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
await import('../../client/node_modules/@deepseek-ai/dsh/lib/bin.js')
const hash = execFileSync('bash', ['-c', 'sha256sum package.json package-lock.json packages/*/package.json | sha256sum'], { encoding: 'utf8' }).split(' ')[0]
await writeFile('node_modules/.edmore-dependency-hash', hash + '\n')
console.log('Validated dependency stamp saved')
