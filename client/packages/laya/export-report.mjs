import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), 'evaluation');
const read = name => JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
const cases = read('cases.json');
const results = read('results.json');
const binary = read('binary-results.json');
const audit = read('label-audit.json');
const byId = new Map(results.map(row => [row.id, row]));
const binaryById = new Map(binary.map(row => [row.id, row]));
if (cases.length !== 120 || results.length !== 120 || binary.length !== 60 || byId.size !== 120 || binaryById.size !== 60) {
  throw new Error('Unexpected or duplicate evaluation records');
}
const out = [];
const add = text => out.push(text);
const json = value => add('```json\n' + JSON.stringify(value, null, 2) + '\n```');
add('# Laya 测试集与完整结果\n');
add('日期：2026-09-22。本文完整收录 120 条测试用例及其原始推理结果，并收录其中 60 条路由用例的二分类补测，共 180 次推理。本文只整理已有结果，没有重新运行模型。\n');
add('## 结论\n');
add('当前测试配置不适合直接替换 EDMORE 的 plan 路由和步骤 judge。现有生产逻辑保持不变，未接入插件。\n');
add('| 测试 | 正确数 | 关键问题 |\n| --- | --- | --- |\n| 路由三分类 | 17/60 (28.3%) | 36 条不确定，7 条普通请求误入 plan |\n| 路由二分类补测 | 37/60 (61.7%) | 1 条漏 plan，22 条普通请求误入 plan |\n| 步骤三分类（标签复核后） | 43/60 (71.7%) | 7 条证据不足的结果误判成功 |\n');
add('主测试按所选类别概率 >= 0.95 且结果不是 uncertain 筛选，两项任务的可接管数量均为 0。模型概率和 entropy confidence 都不是经过校准的正确率。\n');
add('测试用例来自 EDMORE 历史启发、改写及反事实构造，不是 120 次独立历史回放。中英文路由对和步骤结果变体存在关联。二分类补测复用同一批路由用例，不是独立留出集。没有进行训练、门槛拟合、真实硬件操作或当前 LLM judge 的对照推理。\n');
add('## 原始评估报告与方法\n');
add(fs.readFileSync(path.join(root, 'REPORT.md'), 'utf8').replace(/^#/gm, '##'));
add('## 标签修正\n');
add('以下修正只影响复核统计，不覆盖原始测试集或原始输出中的 expected/correct 字段。逐条结果同时列出原始标签与复核标签。\n');
json(audit);
add('## 汇总数据\n');
for (const name of ['audited-summary.json', 'binary-summary.json', 'summary.json', 'provenance.json']) {
  add(`### ${name}\n`);
  json(read(name));
}
add('## 完整测试集与逐条结果\n');
for (const item of cases) {
  const result = byId.get(item.id);
  if (!result) throw new Error('Missing result: ' + item.id);
  const expected = audit[item.id]?.expected ?? item.expected;
  add(`### ${item.id}\n`);
  add(`任务：${item.task}；原始预期：${item.expected}；复核预期：${expected}；主测试输出：${result.predicted}；复核判定：${result.predicted === expected ? '正确' : '错误'}。\n`);
  add('#### 完整用例\n');
  add('state 是模型接收的状态；其余字段是测试元数据，不作为模型输入。\n');
  json(item);
  add('#### 主测试原始结果\n');
  json(result);
  if (binaryById.has(item.id)) {
    add('#### 二分类补测原始结果\n');
    json(binaryById.get(item.id));
  }
}
add('## 历史完整输入长度诊断\n');
add('以下 62 条历史输入仅做 tokenizer 长度检查，未作为额外推理测试。记录含本机历史文件路径，外发前应检查隐私信息。\n');
json(read('historical-input-budget.json'));
add('## 实际测试脚本\n');
add('为保留完整问题、选项、输入构造及模型选择规则，以下附上本次评估脚本。\n');
for (const name of ['server.py', 'evaluate.py', 'supplement.py', 'analyze.py', 'requirements.txt']) {
  add(`### ${name}\n`);
  add('```' + (name.endsWith('.py') ? 'python' : 'text') + '\n' + fs.readFileSync(path.join(root, '..', name), 'utf8').trimEnd() + '\n```');
}
const target = path.join(root, 'FULL-EVALUATION.md');
fs.writeFileSync(target, out.join('\n') + '\n');
const document = fs.readFileSync(target, 'utf8');
if ((document.match(/^### (?:route|step)-/gm) ?? []).length !== 120 ||
    (document.match(/^#### 主测试原始结果/gm) ?? []).length !== 120 ||
    (document.match(/^#### 二分类补测原始结果/gm) ?? []).length !== 60) {
  throw new Error('Report completeness check failed');
}
console.log(JSON.stringify({ target, cases: cases.length, primary: results.length, supplementary: binary.length, bytes: Buffer.byteLength(document) }));
