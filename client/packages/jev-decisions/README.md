# Optional Jev Decisions

`edmore-jev-decisions` replaces only initial Plan routing and individual executed-step semantic assessment. It depends on `edmore-plan-judge` and Harness credentials; neither the original plugin nor its package depends on Jev. No additional model SDK is required.

The backend profile includes the plugin **disabled by default**. Enable its `edmore-jev-decisions` entry in the existing plugin configuration UI or a Harness composition patch, then restart the backend. Set the `TYPESAFE_API_KEY` credential through Harness credentials (or its environment variable); config contains the reference, never the secret. Requests go directly to the official TypeSafe `https://api.typesafe.ai/v1/systemone` endpoint with model `jev-latest`.

## Fallback

- Missing/unloaded plugin: original Plan/Judge behavior, with no network call.
- Missing key, timeout (2.5 seconds), HTTP/network error, invalid response, unexpected model, or oversized input: original model judgment.
- A step-level `uncertain`, low confidence (below 0.90), or small probability margin (below 0.20) pauses the workflow for review. Low-confidence Plan routing still falls back to the original router.
- Three consecutive request/validation failures: bypass Jev for 30 seconds, then retry on a later decision. No immediate retry latency.
- Unload aborts in-flight work; late results cannot override the fallback. A hung provider cannot block the original judge beyond the configured deadline.
- If the original judge also fails, its existing error/uncertain behavior remains. Fallback never means automatically declaring success or bypassing approval.

Each step sends only its compiled criterion and the current MCP structured result. The fallback LLM receives the same minimal input and does not receive skill text, conversation history, earlier tool results, or confirmation context. Inputs over the configured byte budget fall back without truncation; common explicit secret fields are redacted.

Plan validation, physical/confirmation gates, deterministic completion checks, recovery policy, and full-plan semantic review remain authoritative and unchanged. A Jev success can never override a deterministic failure. Jev has no tool execution capability.

This is not a correctness oracle: confident errors are possible and are not detectable merely from the score. Thresholds are conservative configuration defaults, not calibrated guarantees. The earlier benchmark used narrower inputs; the live adapter adds skill/context evidence and must not inherit its accuracy claims. Start with non-hardware or supervised workflows.

Debug logs contain only fixed outcome codes, never API bodies, credentials, queries or raw tool output. Removing or disabling this package restores the baseline path.

## Search-first decision

Reused the existing Cordis `ctx.effect` registration/disposal pattern and the official TypeSafe System One HTTP contract rather than adding another orchestration framework or SDK.

- TypeSafe Jev API: https://api.typesafe.ai/v1/systemone
- Cordis service lifecycle examples: https://github.com/cordiverse/cordis/blob/main/packages/core/tests/service.spec.ts
- Local references: `packages/core/src/scheduling.ts`, `packages/laya/run-history-step-test.py`.

Run tests from `client`: `npm test`. Live credentials are not required by the tests; HTTP is mocked and no instrument commands are sent.
