# EDMORE Terminal UI

Minimal optional frontend, using the same HTTP actions and SSE UI events as WebUI.
No model credentials, agent loop, workflow engine, or chat storage in this package.
No third-party TUI source is copied. This prototype uses Node terminal primitives.

From `EDMORE/client`:

```sh
node packages/tui/cli.mjs
node packages/tui/cli.mjs --session NOMAD-0fbfafa5
node packages/tui/cli.mjs --demo
```

`--url` selects a backend (default http://127.0.0.1:7380).
Normal mode opens the first existing conversation read-only until you submit input.
`/sessions`, `/open N`, `/approve`, `/quit` are supported. Normal text, including
ROI confirmations, goes through the backend intent router. Page Up/Down scrolls.
Ctrl+C disconnects only; it never cancels workflow execution or stops the daemon.

`--demo` is explicitly labelled, read-only illustrative content for presentation
screenshots; it makes no network requests and is not evidence of hardware execution.
Use a terminal at least 110 columns wide and 32 rows high for the two-column layout.

Exports a Cordis `apply` plugin with disposable terminal ownership. Mount it only
in a separate interactive frontend profile, not the background backend profile.
The executable calls the same frontend implementation without loading another agent.

Prototype limits: no project creation, model settings, image preview, Markdown
formatting, full editor, authentication UI, or reconnect-gap reconciliation beyond
the backend snapshot window yet. Use WebUI for those capabilities.

Tests: `node --test packages/tui/test.mjs`.
