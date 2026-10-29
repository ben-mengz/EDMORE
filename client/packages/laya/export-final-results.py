"""Generate the two final comparison tables from saved model responses."""
import json
from pathlib import Path

BASE = Path(__file__).parent / "evaluation"


def read(name):
    return json.loads((BASE / name).read_text())


def escape(value):
    return str(value).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("|", "&#124;").replace("\n", " ")


def cell(result, expected):
    assert result["expected"] == expected
    value = result["predicted"]
    return value if value == expected else f"**{value}**"


def write_table(name, headers, rows):
    text = "| " + " | ".join(headers) + " |\n"
    text += "| " + " | ".join("---" for _ in headers) + " |\n"
    text += "".join("| " + " | ".join(row) + " |\n" for row in rows)
    (BASE / name).write_text(text)


gpt = read("gpt-5-mini/results.json")
variant = "original-forward"
models = [
    {r["id"]: r for r in read("english-microscope-routing/label-order-test/results.json")
     if r["model"] == "typed-decisions" and r["variant"] == variant},
    {r["id"]: r for r in read("jev-gateway/results.json") if r["variant"] == variant},
    {r["id"]: r for r in gpt if r["variant"] == variant},
]
routes = read("english-microscope-routing/cases.json")
assert len(routes) == 40 and all(len(model) == 40 for model in models)
write_table("PLAN.md", ["Query", "Expected", "Laya (typed-decisions)", "Jev", "GPT-5-mini"],
            [[escape(c["query"]), c["expected"], *[cell(m[c["id"]], c["expected"]) for m in models]] for c in routes])

steps = read("history-step-specific/dataset.json")
models = [
    {r["id"]: r for r in read("history-step-specific/laya-results.json")},
    {r["id"]: r for r in read("history-step-specific/jev-results.json")},
    {r["id"]: r for r in gpt if r["variant"] == "step-specific"},
]
assert len(steps) == 57 and all(len(model) == 57 for model in models)
rows = []
for c in steps:
    q = c["question"]
    query = escape(c["id"] + ": " + q["instructions"])
    query += "<br>" + "<br>".join(escape(k.capitalize() + ": " + v) for k, v in q["criteria"].items())
    query += "<br>Evidence: " + escape(json.dumps(c["state"]))
    for model in models:
        assert model[c["id"]]["input_sha256"] == c["input_sha256"]
    rows.append([query, c["expected"], *[cell(m[c["id"]], c["expected"]) for m in models]])
write_table("TOOL-SUCCESS.md", ["Query, Step-specific Conditions and Evidence", "Expected", "Laya (typed-decisions)", "Jev", "GPT-5-mini"], rows)
print("Generated PLAN.md (40 cases) and TOOL-SUCCESS.md (57 cases); step input hashes verified.")
