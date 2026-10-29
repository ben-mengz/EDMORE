import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), 'evaluation');
const read = name => JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
const cases = read('cases.json');
const audit = read('label-audit.json');
const byId = new Map(cases.map(item => [item.id, item]));
const escape = value => String(value).replace(/\|/g, '&#124;').replace(/[\r\n]+/g, ' ');
const lines = ['| Test Case | Expected Result | Actual Output |', '| --- | --- | --- |'];
for (const [file, mode] of [['results.json', 'Three-class'], ['binary-results.json', 'Binary']]) {
  for (const row of read(file)) {
    const item = byId.get(row.id);
    const expected = audit[item.id]?.expected ?? item.expected;
    let description;
    if (item.task === 'plan') {
      const english = byId.get(item.family + '-en');
      description = `${item.id} (${mode}; ${item.language === 'zh' ? 'tested in Chinese, translated here' : 'English'}): ${english.state.query}`;
    } else {
      const { tool, completion_contract, result } = item.state;
      description = `${item.id}: ${tool}. Completion criteria: ${completion_contract} Tool result: ${JSON.stringify(result)}`;
    }
    lines.push(`| ${escape(description)} | ${escape(expected)} | ${escape(row.predicted)} |`);
  }
}
if (lines.length !== 182) throw new Error('Expected 180 result rows');
const target = path.join(root, 'FULL-EVALUATION.md');
fs.writeFileSync(target, lines.join('\n') + '\n');
console.log(`Wrote ${lines.length - 2} rows to ${target}`);
