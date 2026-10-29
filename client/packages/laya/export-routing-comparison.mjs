import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), 'evaluation', 'english-microscope-routing');
const read = name => JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
const cases = read('cases.json');
const results = read('results.json');
const indexed = new Map(results.map(row => [`${row.id}:${row.model}`, row]));
const escape = value => String(value).replace(/\|/g, '&#124;').replace(/[\r\n]+/g, ' ');
const lines = ['| Query | Expected Result | Root Output | Typed-decisions Output |', '| --- | --- | --- | --- |'];
for (const item of cases) {
  const rows = ['root', 'typed-decisions'].map(model => indexed.get(`${item.id}:${model}`));
  if (rows.some(row => !row || row.query !== item.query || row.expected !== item.expected)) {
    throw new Error(`Missing or inconsistent results for ${item.id}`);
  }
  lines.push(`| ${[item.query, item.expected, ...rows.map(row => row.predicted === item.expected ? row.predicted : `**${row.predicted}**`)].map(escape).join(' | ')} |`);
}
if (cases.length !== 40 || results.length !== 80 || indexed.size !== 80) throw new Error('Unexpected result counts');
const target = path.join(root, 'RESULTS.md');
fs.writeFileSync(target, lines.join('\n') + '\n');
console.log(`Verified 40 queries and 80 predictions: ${target}`);
