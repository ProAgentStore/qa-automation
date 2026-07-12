# QA Automation

A QA-mindset agent that writes and runs browser test flows for your ProAppStore apps. It proposes flows from your live app, saves them to the platform (never your repo), runs them headlessly after every deploy, and links you to the observable runner to watch tests click through your app live.

## AI billing

This generated agent does not use the ProAgentStore Cloudflare Workers AI binding by default. AI calls require caller-provided Cloudflare Workers AI credentials:

- `X-CF-Account-ID`
- `X-CF-AI-Token`

That makes inference spend bill to the caller's Cloudflare account, not the ProAgentStore platform account.

## Development

```bash
pnpm install
pnpm dev
```

## Deploy

```bash
pnpm deploy
```
