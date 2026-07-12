# QA Automation

A QA-mindset ProAgentStore agent for ProAppStore apps. It writes and runs
browser test flows — **specs live in the PAS platform, never in your app
repo** — and hands you observable-runner links so you can watch tests click
through your live app.

## How it works

1. As the app owner, mint a **scoped QA key** (`POST /v1/apps/<app>/qa/keys`).
   The key can only touch that app's `qa/*` routes — the agent never holds an
   owner session token.
2. Chat: `connect <app-id> <qa-key>`.
3. Describe flows in plain language — the agent converts them to validated
   platform flow specs (`@proappstore/qa-spec` format) and saves them.
4. `run` queues headless executions in Cloudflare **Browser Rendering** on the
   PAS platform; `status` reports results with failure diagnosis.
5. Watch any flow live at `https://<app>.proappstore.online/__qa/?flow=<id>`.

Deterministic commands work with no AI credentials; flow authoring and
failure summaries use caller-provided Workers AI (`X-CF-Account-ID` /
`X-CF-AI-Token`).

Part of proappstore-online/platform#38 + ProAgentStore/platform#14.
