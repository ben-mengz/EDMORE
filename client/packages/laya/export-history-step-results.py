"""Readable English per-step prompts, evidence and paired model outputs."""
import json
from pathlib import Path

OUT = Path(__file__).parent / "evaluation/history-step-specific"
read = lambda name: json.loads((OUT / name).read_text())
cases = read("dataset.json")
def escape(text):
    return str(text).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("|", "&#124;").replace("\n", " ")
def prompt(c):
    q = c["question"]
    return escape(q["instructions"]) + "<br>" + "<br>".join(escape(k.capitalize() + ": " + v) for k, v in q["criteria"].items())
def evidence(c):
    return escape(json.dumps(c["state"], ensure_ascii=False))
def table(name, headers, rows):
    text = "| " + " | ".join(headers) + " |\n| " + " | ".join("---" for _ in headers) + " |\n"
    text += "\n".join("| " + " | ".join(row) + " |" for row in rows) + "\n"
    (OUT / name).write_text(text)

table("DATASET.md", ["Step-specific Prompt", "Observed Evidence", "Expected Result"],
      [[c["id"] + "<br>" + prompt(c), evidence(c), c["expected"]] for c in cases])
if not all((OUT / f"{m}-results.json").exists() for m in ("laya", "jev")):
    print("Dataset table written; waiting for both model runs.")
    raise SystemExit(0)
models = {m: {r["id"]: r for r in read(f"{m}-results.json")} for m in ("laya", "jev")}
assert all(len(rows) == len(cases) for rows in models.values())
def output(model, c):
    row = models[model][c["id"]]
    assert row["input_sha256"] == c["input_sha256"] and row["expected"] == c["expected"]
    value = row["predicted"]
    return value if value == c["expected"] else "**" + value + "**"
for model in models:
    table(model.upper() + "-RESULTS.md", ["Test Case and Its Conditions", "Expected Result", "Actual Output"],
          [[c["id"] + "<br>" + prompt(c) + "<br>Evidence: " + evidence(c), c["expected"], output(model, c)] for c in cases])
paired = []
unique = []
seen = set()
for c in cases:
    row = [c["id"] + "<br>" + prompt(c) + "<br>Evidence: " + evidence(c), c["expected"], output("laya", c), output("jev", c)]
    paired.append(row)
    if c["input_sha256"] not in seen:
        unique.append(row)
        seen.add(c["input_sha256"])
table("COMPARISON.md", ["Test Case and Its Conditions", "Expected Result", "Laya Typed-decisions", "Jev"], paired)
table("UNIQUE-COMPARISON.md", ["Test Case and Its Conditions", "Expected Result", "Laya Typed-decisions", "Jev"], unique)
print(json.dumps({"paired_rows": len(paired), "unique_rows": len(unique), "input_identity_checked": True}))
