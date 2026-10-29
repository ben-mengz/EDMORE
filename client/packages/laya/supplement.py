"""Declared follow-up: binary routing with language-matched models; no tuning."""
import json
from pathlib import Path
from collections import Counter
from time import perf_counter
import laya
from huggingface_hub import snapshot_download
from server import REVISION

OUT = Path(__file__).parent / "evaluation"
cases = json.loads((OUT / "cases.json").read_text())
models = {}
for language, subfolder in [("en", ""), ("zh", "multilingual")]:
    prefix = subfolder + "/" if subfolder else ""
    root = snapshot_download("convaiinnovations/laya", revision=REVISION,
        allow_patterns=[prefix + p for p in ("rl_agent_config.json", "model.safetensors", "tokenizer/*", "encoder/*")])
    models[language] = laya.load(root, subfolder=subfolder or None, device="cpu")

question = {"type": "choice", "instructions": "Does this user request need a new PlanReview? Follow the policy in state.",
            "criteria": {"plan": "Execution of hardware, acquisition, reconstruction, parameter updates or workflows, including simulation.",
                         "direct": "Explanations, status/history reading, listing tools or conversation."}}
rows = []
for case in cases:
    if case["task"] != "plan":
        continue
    agent = models[case["language"]]
    from laya.common import serialize_state, build_sequence
    q = agent._to_internal(question)
    # Compare untruncated and actual sequences before inference.
    full, _ = build_sequence(agent.tok, case["state"], q, 100000, agent.cfg["head_max_len"])
    if len(full) > agent.cfg["max_len"]:
        raise ValueError("Unexpected truncation")
    start = perf_counter()
    result = agent.predict(case["state"], {"decision": question})
    answer = result["answers"]["decision"]
    rows.append({"id": case["id"], "expected": case["expected"], "language": case["language"],
                 "response": result, "predicted": answer["choice"], "correct": answer["choice"] == case["expected"],
                 "elapsed_ms": round((perf_counter()-start)*1000, 2), "revision": REVISION})
    print(case["id"], answer["choice"], rows[-1]["correct"], flush=True)
(OUT / "binary-results.json").write_text(json.dumps(rows, indent=2) + "\n")
summary = {"count": len(rows), "correct": sum(r["correct"] for r in rows),
    "confusion": dict(Counter(r["expected"] + " -> " + r["predicted"] for r in rows)),
    "by_language": {lang: {"count": 30, "correct": sum(r["correct"] for r in rows if r["language"] == lang)} for lang in ("en", "zh")}}
(OUT / "binary-summary.json").write_text(json.dumps(summary, indent=2) + "\n")
print(json.dumps(summary, indent=2))
