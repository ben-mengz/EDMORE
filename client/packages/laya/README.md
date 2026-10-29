# Laya offline evaluation only

This directory is an experiment, not a registered EDMORE plugin. Production
code and profile configuration are unchanged. Plugin implementation is deferred
until the evaluation supports it.

```sh
uv venv --python 3.12 .venv
uv pip install --python .venv/bin/python -r requirements.txt
.venv/bin/python -u evaluate.py
.venv/bin/python -u supplement.py
.venv/bin/python -u analyze.py
```

The script builds 120 short history-inspired challenge cases and runs real local
inference. Labels and provenance are stored separately from model input.
English/Chinese route pairs and step counterfactuals are correlated families,
not independent historical episodes. No model fitting or threshold tuning is
performed on this set. Model revision is pinned in server.py.

server.py contains the standalone engine and an optional loopback HTTP server.
Tests use the engine directly. Oversized input is rejected, never truncated.
No hardware tools are executed. See evaluation/ for data, responses and metrics.

Read evaluation/REPORT.md for the decision and limitations. The supplementary
run reuses the 60 route cases; it does not add independent test cases. Analysis
reads local EDMORE session history and applies an explicit label audit without
overwriting the original responses.
