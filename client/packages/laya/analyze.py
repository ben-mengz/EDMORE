"""Analyze frozen outputs, retaining the original run and explicit label audit."""
import json
import statistics
from pathlib import Path
from collections import Counter
from transformers import AutoTokenizer
from huggingface_hub import snapshot_download
from server import REVISION

OUT = Path(__file__).parent / "evaluation"
cases = json.loads((OUT / "cases.json").read_text())
rows = json.loads((OUT / "results.json").read_text())
# Current acquire-4d-stem Success Criteria explicitly makes missing scan grid a failure.
overrides = {"step-06-uncertain": {"expected": "failure", "reason": "Current acquire-4d-stem/SKILL.md:75 explicitly defines missing scan-grid errors as failed acquisition. Initial label was incorrect; preserve it for audit."}}
(OUT / "label-audit.json").write_text(json.dumps(overrides, indent=2) + "\n")
for row in rows:
    row["expected"] = overrides.get(row["id"], {}).get("expected", row["expected"])
    row["correct"] = row.get("predicted") == row["expected"]
summary = {}
for task in ("plan", "step"):
    subset = [r for r in rows if r["task"] == task]
    high_probability = [r for r in subset if r.get("response", {}).get("answers", {}).get("decision", {}).get("probabilities", {}).get(r.get("predicted"), 0) >= .95]
    accepted = [r for r in high_probability if r.get("predicted") != "uncertain"]
    summary[task] = {"count": len(subset), "correct": sum(r["correct"] for r in subset),
        "confusion": dict(Counter(r["expected"] + " -> " + r.get("predicted", "error") for r in subset)),
        "median_ms": statistics.median(r["wall_ms"] for r in subset),
        "high_probability_at_095": len(high_probability),
        "accepted_at_095": len(accepted), "wrong_at_095": sum(not r["correct"] for r in accepted),
        "false_success": [r["id"] for r in subset if task == "step" and r.get("predicted") == "success" and r["expected"] != "success"]}
(OUT / "audited-summary.json").write_text(json.dumps(summary, indent=2) + "\n")

root = snapshot_download("convaiinnovations/laya", revision=REVISION, allow_patterns=["typed-decisions/tokenizer/*"])
tok = AutoTokenizer.from_pretrained(str(Path(root) / "typed-decisions/tokenizer"))
prompts = {}
for path in (Path.home() / ".dsh/edmore/sessions").rglob("session.v3.jsonl"):
    if "judge" not in str(path):
        continue
    for line in path.read_text().splitlines():
        record = json.loads(line)
        for item in record.get("data", {}).get("inserted", []):
            for block in item.get("content", []):
                text = block.get("text", "")
                if "Judge the outcome of ONE executed workflow step" in text:
                    prompts[text] = {"source": str(path), "seq": record.get("seq"), "tokens": len(tok(text, add_special_tokens=False)["input_ids"])}
lengths = list(prompts.values())
(OUT / "historical-input-budget.json").write_text(json.dumps({"count": len(lengths),
    "over_1024": sum(r["tokens"] > 1024 for r in lengths), "inputs": lengths}, indent=2) + "\n")
print(json.dumps(summary, indent=2))
print("Historical judge prompts:", len(lengths), "over budget:", sum(r["tokens"] > 1024 for r in lengths))
