"""Identical frozen, step-specific questions for local Laya and hosted Jev."""
import argparse
import getpass
import hashlib
import json
import os
import time
from collections import Counter
from pathlib import Path

from server import REVISION

ROOT = Path(__file__).parent
OUT = ROOT / "evaluation/history-step-specific"
DATA = OUT / "dataset.json"
cases = json.loads(DATA.read_text())
digest = hashlib.sha256(DATA.read_bytes()).hexdigest()
parser = argparse.ArgumentParser()
parser.add_argument("--model", choices=["laya", "jev", "preflight"], required=True)
args = parser.parse_args()

def save(name, value):
    (OUT / name).write_text(json.dumps(value, indent=2) + "\n")

if args.model in ("laya", "preflight"):
    from huggingface_hub import snapshot_download
    from transformers import AutoTokenizer
    from laya.common import build_sequence, render_options
    root = snapshot_download("convaiinnovations/laya", revision=REVISION,
        allow_patterns=["typed-decisions/" + p for p in ("rl_agent_config.json", "model.safetensors", "tokenizer/*", "encoder/*")])
    checkpoint = Path(root) / "typed-decisions"
    config = json.loads((checkpoint / "rl_agent_config.json").read_text())
    tokenizer = AutoTokenizer.from_pretrained(str(checkpoint / "tokenizer"))
    budgets = []
    for c in cases:
        question = c["question"]
        internal = {"t": "choice", "ins": question["instructions"], "crit": question["criteria"]}
        options = [len(tokenizer(" " + t, add_special_tokens=False)["input_ids"]) for t in render_options(internal)]
        full, _ = build_sequence(tokenizer, c["state"], internal, 100000, 100000)
        actual, _ = build_sequence(tokenizer, c["state"], internal, config["max_len"], config["head_max_len"])
        budgets.append({"id": c["id"], "tokens": len(full), "option_tokens": options,
                        "no_truncation": actual == full and max(options) <= 48})
    save("input-budget.json", {"dataset_sha256": digest, "max_len": config["max_len"], "head_max_len": config["head_max_len"], "cases": budgets})
    bad = [b for b in budgets if not b["no_truncation"]]
    if bad:
        print(json.dumps(bad, indent=2))
        raise SystemExit("Preflight failed; no inference was run.")
    print(f"Preflight: {len(cases)} inputs, no truncation, maximum {max(b['tokens'] for b in budgets)} tokens.", flush=True)
    if args.model == "preflight":
        raise SystemExit(0)
    import laya
    agent = laya.load(root, subfolder="typed-decisions", device="cpu")
else:
    import requests
    budget = json.loads((OUT / "input-budget.json").read_text())
    assert budget["dataset_sha256"] == digest and all(c["no_truncation"] for c in budget["cases"])
    key = os.environ.get("TYPESAFE_API_KEY") or getpass.getpass("TypeSafe API key (hidden): ")
    session = requests.Session()
    session.headers.update({"Authorization": "Bearer " + key})

path = OUT / f"{args.model}-results.json"
rows = json.loads(path.read_text()) if path.exists() else []
assert all(r["dataset_sha256"] == digest for r in rows), "Dataset changed; do not mix runs."
done = {r["id"] for r in rows}
for c in cases:
    if c["id"] in done:
        continue
    attempts = []
    if args.model == "laya":
        started = time.perf_counter()
        response = agent.predict(c["state"], {"decision": c["question"]})
        elapsed = (time.perf_counter() - started) * 1000
    else:
        for attempt in range(6):
            time.sleep(2 if attempt == 0 else min(60, 5 * 2 ** (attempt - 1)))
            started = time.perf_counter()
            try:
                http = session.post("https://api.typesafe.ai/v1/systemone",
                    json={"model": "jev-latest", "state": c["state"], "questions": {"decision": c["question"]}},
                    timeout=(10, 45), allow_redirects=False)
                elapsed = (time.perf_counter() - started) * 1000
                response = http.json()
            except (requests.RequestException, ValueError) as error:
                raise SystemExit("Transport/JSON failure; saved results preserved: " + type(error).__name__)
            attempts.append({"status": http.status_code, "request_ms": round(elapsed, 2)})
            if http.status_code == 200:
                assert str(response.get("model", "")).startswith("jev-")
                break
            if http.status_code not in (429, 502, 503, 504) or attempt == 5:
                save("jev-last-error.json", {"case_id": c["id"], "status": http.status_code,
                    "response": json.loads(json.dumps(response).replace(key, "[REDACTED]"))})
                raise SystemExit(f"Gateway HTTP {http.status_code}; saved results preserved.")
            print(f"HTTP {http.status_code}; backing off", flush=True)
    prediction = response["answers"]["decision"]["choice"]
    assert prediction in c["question"]["criteria"]
    row = {"id": c["id"], "model": args.model, "revision": REVISION if args.model == "laya" else "hosted-unpinned",
        "dataset_sha256": digest, "input_sha256": c["input_sha256"], "expected": c["expected"],
        "predicted": prediction, "correct": prediction == c["expected"], "response": response,
        "request_ms": round(elapsed, 2), "attempts": attempts}
    rows.append(row)
    save(path.name, rows)
    print(len(rows), c["id"], prediction, row["correct"], flush=True)
if args.model == "jev":
    session.close()
    del key
assert len(rows) == len(cases)
def metrics(subset):
    return {"count": len(subset), "correct": sum(r["correct"] for r in subset),
        "confusion": dict(Counter(r["expected"] + " -> " + r["predicted"] for r in subset)),
        "false_success_ids": [r["id"] for r in subset if r["predicted"] == "success" and r["expected"] != "success"]}
unique = {}
for row in rows:
    unique.setdefault(row["input_sha256"], row)
summary = {"all_events": metrics(rows), "unique_inputs_first_observation": metrics(list(unique.values()))}
save(f"{args.model}-summary.json", summary)
print(json.dumps(summary, indent=2))
