"""Reproducible, descriptive figures for the frozen three-model evaluation."""
import hashlib
import json
import textwrap
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.colors import ListedColormap
from matplotlib.patches import Patch
import numpy as np

BASE = Path(__file__).parent / "evaluation"
OUT = BASE / "figures"
OUT.mkdir(exist_ok=True)
sources = {}


def read(name):
    path = BASE / name
    sources[name] = hashlib.sha256(path.read_bytes()).hexdigest()
    return json.loads(path.read_text())


names = ["Laya", "Jev", "GPT-5-mini"]
colors = ["#0072B2", "#00805A", "#AA4678"]
routes = read("english-microscope-routing/cases.json")
gpt = read("gpt-5-mini/results.json")
variant = "original-forward"
plan = [
    {r["id"]: r for r in read("english-microscope-routing/label-order-test/results.json") if r["model"] == "typed-decisions" and r["variant"] == variant},
    {r["id"]: r for r in read("jev-gateway/results.json") if r["variant"] == variant},
    {r["id"]: r for r in gpt if r["variant"] == variant},
]
steps = read("history-step-specific/dataset.json")
step = [{r["id"]: r for r in read(f"history-step-specific/{m}-results.json")} for m in ("laya", "jev")]
step.append({r["id"]: r for r in gpt if r["variant"] == "step-specific"})
for cases, models in ((routes, plan), (steps, step)):
    for model in models:
        assert set(model) == {c["id"] for c in cases}
        for c in cases:
            assert model[c["id"]]["expected"] == c["expected"]
            if "input_sha256" in c:
                assert model[c["id"]]["input_sha256"] == c["input_sha256"]


def correct(model, cases):
    return sum(model[c["id"]]["predicted"] == c["expected"] for c in cases)


def save(fig, name):
    fig.canvas.draw()
    for fmt in ("png", "pdf", "svg"):
        fig.savefig(OUT / f"{name}.{fmt}", dpi=180, facecolor="white")
    plt.close(fig)


style = {"font.family": "DejaVu Sans", "font.size": 11, "axes.titlesize": 14,
         "axes.titleweight": "bold", "axes.spines.top": False, "axes.spines.right": False,
         "pdf.fonttype": 42, "svg.fonttype": "none", "text.color": "#20252B",
         "axes.labelcolor": "#20252B", "xtick.color": "#20252B", "ytick.color": "#20252B"}
errors = [c for c in routes if any(m[c["id"]]["predicted"] != c["expected"] for m in plan)]
assert all(m[c["id"]]["predicted"] == "plan" for c in errors for m in plan if m[c["id"]]["predicted"] != c["expected"])
with plt.rc_context(style):
    fig = plt.figure(figsize=(13, 11.5))
    grid = fig.add_gridspec(2, 2, height_ratios=[1, 3.2], hspace=.65, wspace=.38,
                          left=.07, right=.97, top=.88, bottom=.10)
    fig.suptitle("Plan routing: Jev makes the fewest errors on this test set", x=.07, y=.97, ha="left", fontsize=19, weight="bold")
    fig.text(.07, .927, "40 English queries | 15 require Plan; 25 should go Direct | Original-forward configuration", fontsize=12)
    ax = fig.add_subplot(grid[0, 0])
    scores = [correct(m, routes) for m in plan]
    bars = ax.barh(names, np.array(scores) / 40 * 100, color=colors, height=.58)
    ax.invert_yaxis()
    ax.set(xlim=(0, 100), xlabel="Correct decisions (%)", title="A  Overall accuracy")
    ax.set_xticks([0, 25, 50, 75, 100])
    for bar, value in zip(bars, scores):
        ax.text(2, bar.get_y() + bar.get_height()/2, f"{value}/40  ({value/40:.1%})", color="white", va="center", weight="bold")
    ax = fig.add_subplot(grid[0, 1])
    bad = [40 - s for s in scores]
    ax.barh(names, bad, color=colors, height=.58)
    ax.invert_yaxis()
    ax.set(xlim=(0, 25), xlabel="Unnecessary Plan decisions (out of 25 Direct queries)", title="B  Every error is an unnecessary Plan")
    ax.set_xticks([0, 5, 10, 15, 20, 25])
    for i, count in enumerate(bad):
        ax.text(count + .4, i, str(count), va="center", weight="bold")
    ax = fig.add_subplot(grid[1, :])
    data = np.array([[int(m[c["id"]]["predicted"] != c["expected"]) for m in plan] for c in errors])
    ax.imshow(data, cmap=ListedColormap(["#E9F2F6", "#F4D0BE"]), vmin=0, vmax=1, aspect="auto", extent=(0, 3, len(errors), 0))
    ax.set_xlim(-7.7, 3)
    ax.set_xticks([.5, 1.5, 2.5], names)
    ax.xaxis.tick_top()
    ax.tick_params(axis="both", length=0)
    ax.set_yticks([])
    ax.set_title("C  Queries with at least one wrong answer (expected: Direct)", loc="left", pad=30)
    for i, c in enumerate(errors):
        ax.text(-7.6, i + .5, textwrap.fill(c["query"], 76), va="center", fontsize=10)
        for j in range(3):
            ax.text(j + .5, i + .5, "PLAN !" if data[i, j] else "Direct", ha="center", va="center", fontsize=10, weight="bold" if data[i,j] else "normal")
        ax.axhline(i + 1, color="white", linewidth=1.2)
    for spine in ax.spines.values():
        spine.set_visible(False)
    fig.text(.07, .048, f"All remaining {40-len(errors)} queries were classified correctly by all three models. Laya = typed-decisions.", fontsize=11)
    fig.text(.07, .022, "Observed results only; reused exploratory data, not an independent holdout. No population confidence interval is implied.", fontsize=10, color="#50565C")
    save(fig, "plan-comparison")

    unique = list({c["input_sha256"]: c for c in steps}.values())
    fig, axes = plt.subplots(1, 2, figsize=(12, 6))
    fig.subplots_adjust(left=.075, right=.98, bottom=.25, top=.72, wspace=.28)
    fig.suptitle("Tool success: all three models match every expected label", x=.075, y=.96, ha="left", fontsize=18, weight="bold")
    fig.text(.075, .895, "Each input includes its own success, failure and uncertain criteria, plus observed tool evidence.", fontsize=11)
    fig.text(.075, .835, "57/57 correct per model  |  23/23 after deduplication  |  0 false-success decisions", fontsize=13, weight="bold")
    for ax, cases, title in zip(axes, [steps, unique], ["A  All 57 historical records", "B  23 unique inputs"]):
        labels = ["success", "failure", "uncertain"]
        x = np.arange(3)
        for j, (name, model, color) in enumerate(zip(names, step, colors)):
            totals = [sum(c["expected"] == label for c in cases) for label in labels]
            values = [correct(model, [c for c in cases if c["expected"] == label]) for label in labels]
            ax.bar(x + (j-1)*.24, np.array(values)/np.array(totals)*100, width=.21, color=color, label=name, hatch=["", "//", ".."][j])
            assert values == totals
        for k, total in enumerate(totals):
            ax.text(x[k], 103, f"{total}/{total} each", ha="center", fontsize=10, weight="bold")
        ax.set(ylim=(0, 115), xticks=x, xticklabels=["Success", "Failure", "Uncertain"], ylabel="Correct within expected class (%)", title=title)
        ax.set_yticks([0, 25, 50, 75, 100])
        ax.set_xlabel("Expected label")
    fig.legend(handles=[Patch(facecolor=c, label=n, hatch=h) for c,n,h in zip(colors,names,["","//",".."])], loc="lower center", bbox_to_anchor=(.53,.125), ncol=3, frameon=False)
    fig.text(.075,.09,"Counts above bars are correct / total. Laya = typed-decisions. Deduplication uses the exact question + evidence hash.",fontsize=10)
    fig.text(.075,.043,"Perfect on these examples does not establish production reliability: only 6 unique failures and 2 unique uncertain inputs.",fontsize=10,weight="bold")
    save(fig, "tool-success-comparison")

manifest = {"source_sha256": sources, "matplotlib": matplotlib.__version__,
    "plan_correct": dict(zip(names,scores)), "plan_count":40,
    "step_count":len(steps),"step_unique":len(unique),
    "transformations":["original-forward only; Laya typed-decisions", "accuracy = correct / cases", "step deduplication by input_sha256", "plan matrix shows union of errors; remainder disclosed"],
    "uncertainty":"Descriptive finite-dataset results; no independence or population generalization assumed.",
    "destination":"General English comparison figures, not a journal submission", "raster_dpi":180,
    "data_alternatives":["../PLAN.md","../TOOL-SUCCESS.md"],
    "skill":"scientific-visualization 1.2",
    "reference":"Kassis, T., Agarwal, V., He, Y., Patel, D., & Brueckner, A. M. (2026). Scientific Agent Skills: A Library of Procedural Knowledge for Research Agents. https://doi.org/10.48550/arXiv.2609.00065",
    "alt_text":{"plan":"Jev 39/40 (97.5%), GPT-5-mini 35/40 (87.5%), Laya 27/40 (67.5%). All errors unnecessarily trigger Plan; no required Plan is missed.","tool_success":"All models score 57/57, including 45 successes, 10 failures, 2 uncertain. Deduplicated: 15 successes, 6 failures, 2 uncertain; all correct."}}
(OUT / "provenance.json").write_text(json.dumps(manifest, indent=2)+"\n")
print(json.dumps({"plan_correct":manifest["plan_correct"],"error_queries":len(errors),"unique_steps":len(unique),"output":str(OUT)}))
