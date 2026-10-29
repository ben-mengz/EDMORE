import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const base = path.join(path.dirname(fileURLToPath(import.meta.url)), 'evaluation');
const read = file => JSON.parse(fs.readFileSync(path.join(base, file), 'utf8'));
const cases = read('cases.json');
const routes = read('english-microscope-routing/cases.json');
const audit = read('label-audit.json');
const laya = read('results.json');
const jev = read('jev-gateway/results.json');
const escape = text => String(text).replace(/\|/g, '&#124;').replace(/[\r\n]+/g, ' ');
const steps = cases.filter(c => c.task === 'step');
function write(file, inputs, outputs, step) {
  const indexed = new Map(outputs.map(row => [row.id, row]));
  if (indexed.size !== inputs.length) throw new Error('Unexpected result count');
  let errors = 0;
  const lines = ['| Test Case | Expected Result | Actual Output |', '| --- | --- | --- |'];
  for (const c of inputs) {
    const expected = audit[c.id]?.expected ?? c.expected;
    const prediction = indexed.get(c.id)?.predicted;
    if (!prediction) throw new Error('Missing output: ' + c.id);
    const description = step
      ? `${c.state.tool}. Completion criteria: ${c.state.completion_contract} Tool result: ${JSON.stringify(c.state.result)}`
      : c.query;
    const wrong = prediction !== expected;
    errors += Number(wrong);
    lines.push(`| ${escape(description)} | ${expected} | ${wrong ? `**${prediction}**` : prediction} |`);
  }
  const target = path.join(base, file);
  fs.writeFileSync(target, lines.join('\n') + '\n');
  console.log(JSON.stringify({file:target,rows:inputs.length,boldErrors:errors}));
}
write('LAYA-STEP-RESULTS.md', steps, laya.filter(r => r.task === 'step'), true);
write('jev-gateway/JEV-PLAN-RESULTS.md', routes, jev.filter(r => r.variant === 'original-forward'), false);
write('jev-gateway/JEV-STEP-RESULTS.md', steps, jev.filter(r => r.task === 'step'), true);
