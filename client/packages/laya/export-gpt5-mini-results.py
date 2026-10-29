"""Export frozen GPT-5-mini decisions and matched baseline comparisons."""
import json
from pathlib import Path

BASE = Path(__file__).parent / "evaluation"
OUT = BASE / "gpt-5-mini"


def read(path):
    return json.loads(path.read_text())


def escape(value):
    return str(value).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("|", "&#124;").replace("\n", " ")


def output(row, expected):
    assert row["expected"] == expected
    value = row["predicted"]
    return value if value == expected else f"**{value}**"


def table(name, headers, rows):
    text = "| " + " | ".join(headers) + " |\n"
    text += "| " + " | ".join("---" for _ in headers) + " |\n"
    text += "".join("| " + " | ".join(row) + " |\n" for row in rows)
    (OUT / name).write_text(text)
    assert len((OUT / name).read_text().splitlines()) == len(rows) + 2


results = read(OUT / "results.json")
protocol = read(OUT / "protocol.json")
assert len(results) == len(protocol["jobs"]) == 217
indexed = {(r["variant"], r["id"]): r for r in results}
assert len(indexed) == 217
routes = read(BASE / "english-microscope-routing/cases.json")
steps = read(BASE / "history-step-specific/dataset.json")
variants = list(dict.fromkeys(r["variant"] for r in results if r["task"] == "plan"))
laya_plan = {(r["model"], r["variant"], r["id"]): r for r in read(BASE / "english-microscope-routing/label-order-test/results.json")}
jev_plan = {(r["variant"], r["id"]): r for r in read(BASE / "jev-gateway/results.json")}
baseline_steps = {m: {r["id"]: r for r in read(BASE / f"history-step-specific/{m}-results.json")} for m in ("laya", "jev")}
primary = "original-forward"
table("PLAN-RESULTS.md", ["Test Case", "Expected Result", "Actual Output"],
      [[escape(c["query"]), c["expected"], output(indexed[primary, c["id"]], c["expected"])] for c in routes])
table("PLAN-VARIANTS.md", ["Test Case", "Expected Result", *variants],
      [[escape(c["query"]), c["expected"], *[output(indexed[v, c["id"]], c["expected"]) for v in variants]] for c in routes])
table("PLAN-COMPARISON.md", ["Test Case", "Expected Result", "Laya Root", "Laya Typed-decisions", "Jev", "GPT-5-mini"],
      [[escape(c["query"]), c["expected"],
        *[output(laya_plan[m, primary, c["id"]], c["expected"]) for m in ("root", "typed-decisions")],
        output(jev_plan[primary, c["id"]], c["expected"]), output(indexed[primary, c["id"]], c["expected"])] for c in routes])
single, paired, unique, seen = [], [], [], set()
for c in steps:
    q = c["question"]
    prompt = escape(q["instructions"]) + "<br>" + "<br>".join(escape(k.capitalize() + ": " + v) for k, v in q["criteria"].items())
    label = c["id"] + "<br>" + prompt + "<br>Evidence: " + escape(json.dumps(c["state"]))
    gpt = indexed["step-specific", c["id"]]
    assert gpt["input_sha256"] == c["input_sha256"]
    for model in baseline_steps.values():
        assert model[c["id"]]["input_sha256"] == c["input_sha256"]
    single.append([label, c["expected"], output(gpt, c["expected"])])
    row = [label, c["expected"], *[output(baseline_steps[m][c["id"]], c["expected"]) for m in ("laya", "jev")], output(gpt, c["expected"])]
    paired.append(row)
    if c["input_sha256"] not in seen:
        seen.add(c["input_sha256"])
        unique.append(row)
table("TOOL-SUCCESS-RESULTS.md", ["Test Case and Its Conditions", "Expected Result", "Actual Output"], single)
headers = ["Test Case and Its Conditions", "Expected Result", "Laya Typed-decisions", "Jev", "GPT-5-mini"]
table("TOOL-SUCCESS-COMPARISON.md", headers, paired)
table("TOOL-SUCCESS-UNIQUE-COMPARISON.md", headers, unique)
summary = read(OUT / "summary.json")
lines = ["# GPT-5-mini Evaluation", "", "| Test | Correct | Accuracy |", "| --- | --- | --- |"]
for name in [*variants, "step-specific", "step-unique"]:
    score = summary[name]
    lines.append(f"| {name} | {score['correct']}/{score['count']} | {score['correct'] / score['count']:.1%} |")
lines += ["", "- Actual model: " + ", ".join(summary["returned_models"]) + ".",
          "- Harness OpenAI credentials; reasoning effort `" + protocol["reasoning_effort"] + "`; production settings unchanged.",
          "- 217 requests: 40 plan queries under four label/order configurations, plus 57 historical step observations (23 unique inputs).",
          "- Same frozen decision questions, per-step success/failure/uncertain criteria, evidence and expected labels as the previous evaluations. Expected labels were not sent to the model.",
          "- API adaptation: question in the system message, evidence in the user message, strict JSON enum output. Serialization differs from Laya/Jev; no confidence scores requested.",
          "- Plan primary result is original-forward, chosen before evaluation. Explicit variant labels are normalized to plan/direct in tables.",
          "- Step baselines use history-step-specific, not the older synthetic 60-case dataset. Input hashes checked across all three models.",
          "- Wrong outputs are bold. Every step row includes its own criteria and observed evidence.",
          "- This reused exploratory dataset is not an independent holdout. Repeated easy successes inflate the 57-row score; the 23-unique score is also reported. No physical outcome was independently verified.",
          "- Raw responses and token usage: results.json. Frozen inputs and API settings: protocol.json. Aggregate metrics: summary.json.", ""]
(OUT / "README.md").write_text("\n".join(lines))
print(json.dumps({"plan_rows": len(routes), "step_rows": len(single), "unique_step_rows": len(unique), "input_hashes_verified": True}))
