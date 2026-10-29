"""Build paired tables from recorded responses; does not call any model."""
import json
from collections import Counter
from pathlib import Path

BASE = Path(__file__).parent / "evaluation"
OUT = BASE / "jev-gateway"
read = lambda p: json.loads(p.read_text())
jev = read(OUT / "results.json")
laya = read(BASE / "english-microscope-routing/label-order-test/results.json")
cases = read(BASE / "english-microscope-routing/cases.json")
steps = [c for c in read(BASE / "cases.json") if c["task"] == "step"]
audit = read(BASE / "label-audit.json")
step_laya = {r["id"]: r for r in read(BASE / "results.json") if r["task"] == "step"}
assert len(jev) == 220 and len(laya) == 320
assert len({(r["id"], r["variant"]) for r in jev}) == 220
assert all(r["response"]["model"] == "typesafe-ai/jev" for r in jev)
j = {(r["id"], r["variant"]): r for r in jev}
l = {(r["model"], r["id"], r["variant"]): r for r in laya}
esc = lambda x: str(x).replace("|", "&#124;").replace("\n", " ")
def cell(prediction, expected):
    return prediction if prediction == expected else "**" + prediction + "**"

lines = ["| Query | Expected Result | Laya Root | Laya Typed-decisions | Jev |", "| --- | --- | --- | --- | --- |"]
metrics = {}
for model in ("root", "typed-decisions", "jev"):
    rows = [j[c["id"], "original-forward"] if model == "jev" else l[model, c["id"], "original-forward"] for c in cases]
    metrics[model] = {"count": len(rows), "correct": sum(r["predicted"] == c["expected"] for r, c in zip(rows, cases)),
        "confusion": dict(Counter(c["expected"] + " -> " + r["predicted"] for r, c in zip(rows, cases)))}
for c in cases:
    predictions = [l[model, c["id"], "original-forward"]["predicted"] for model in ("root", "typed-decisions")]
    predictions.append(j[c["id"], "original-forward"]["predicted"])
    lines.append("| " + " | ".join(map(esc, [c["query"], c["expected"]] + [cell(p, c["expected"]) for p in predictions])) + " |")
(OUT / "COMPARISON.md").write_text("\n".join(lines) + "\n")

lines = ["| Test Case | Expected Result | Laya Typed-decisions | Jev |", "| --- | --- | --- | --- |"]
step_metrics = {}
for model in ("laya", "jev"):
    pairs = [(c, step_laya[c["id"]] if model == "laya" else j[c["id"], "step"]) for c in steps]
    confusion = Counter(audit.get(c["id"], {}).get("expected", c["expected"]) + " -> " + r["predicted"] for c, r in pairs)
    step_metrics[model] = {"count": 60, "correct": sum(v for key, v in confusion.items() if len(set(key.split(" -> "))) == 1),
        "confusion": dict(confusion), "false_success": sum(v for key, v in confusion.items() if key.endswith(" -> success") and not key.startswith("success -> "))}
for c in steps:
    expected = audit.get(c["id"], {}).get("expected", c["expected"])
    s = c["state"]
    description = s["tool"] + ". Completion criteria: " + s["completion_contract"] + " Tool result: " + json.dumps(s["result"])
    lines.append("| " + " | ".join(map(esc, [description, expected, cell(step_laya[c["id"]]["predicted"], expected), cell(j[c["id"], "step"]["predicted"], expected)])) + " |")
(OUT / "STEP-COMPARISON.md").write_text("\n".join(lines) + "\n")
comparison = {"routing": metrics, "step": step_metrics,
    "reported_gateway_cost": sum(float(r["response"].get("provider_metadata", {}).get("gateway", {}).get("cost", 0)) for r in jev)}
(OUT / "comparison.json").write_text(json.dumps(comparison, indent=2) + "\n")
print(json.dumps(comparison, indent=2))
