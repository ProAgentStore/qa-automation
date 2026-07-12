/**
 * QA Automation — a ProAgentStore agent with a QA mindset
 * (ProAgentStore/platform#14, consumes proappstore-online/platform#38).
 *
 * What it does, per connected ProAppStore app:
 *  - stores a SCOPED QA key (never an owner session token)
 *  - lists / saves / deletes platform test flows (specs live in the PAS
 *    platform D1 — never in the app's repo)
 *  - triggers headless runs (Cloudflare Browser Rendering, platform-side)
 *  - reads results and explains failures
 *  - links to the observable runner (<app>/__qa/?flow=<id>) so the owner can
 *    WATCH a flow click through the live app
 *
 * Design rule: every command works deterministically WITHOUT AI credentials.
 * Caller-provided Workers AI is used only to (a) turn a plain-language flow
 * description into a validated spec and (b) summarize failures.
 */

import { DurableObject } from "cloudflare:workers";
import { Hono } from "hono";

interface Env {
	AGENT: DurableObjectNamespace;
}

const PAS_API = "https://api.proappstore.online";
const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

const SYSTEM_PROMPT = `You are QA Automation, a meticulous QA engineer for ProAppStore apps.
You think in edge cases, wrong inputs, and empty states — never happy-path only.
You write browser test flows as JSON in the platform flow format and never touch app code.`;

// ── vendored from @proappstore/qa-spec (vendor, don't depend — cross-store) ──

interface Target { label?: string; text?: string; selector?: string }
type Step =
	| { op: "goto"; path: string }
	| { op: "click"; target: Target }
	| { op: "clickPoint"; xPct: number; yPct: number }
	| { op: "fill"; target: Target; value: string }
	| { op: "press"; key: string }
	| { op: "expectVisible"; target: Target }
	| { op: "expectText"; text: string }
	| { op: "waitFor"; ms?: number; target?: Target }
	| { op: "screenshot"; name?: string };
interface TestFlow { id: string; name: string; startPath?: string; steps: Step[] }

const FLOW_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const OPS = new Set(["goto", "click", "clickPoint", "fill", "press", "expectVisible", "expectText", "waitFor", "screenshot"]);

function validateFlow(raw: unknown): string | null {
	if (!raw || typeof raw !== "object") return "flow must be an object";
	const flow = raw as Partial<TestFlow>;
	if (typeof flow.id !== "string" || !FLOW_ID_RE.test(flow.id)) return "flow.id must be a slug";
	if (typeof flow.name !== "string" || !flow.name.trim() || flow.name.length > 120) return "flow.name required (≤120 chars)";
	if (flow.startPath !== undefined && (typeof flow.startPath !== "string" || !flow.startPath.startsWith("/"))) return 'startPath must start with "/"';
	if (!Array.isArray(flow.steps) || flow.steps.length === 0 || flow.steps.length > 100) return "steps must be 1–100 entries";
	for (let i = 0; i < flow.steps.length; i++) {
		const s = flow.steps[i] as Record<string, unknown>;
		if (!s || typeof s.op !== "string" || !OPS.has(s.op)) return `step ${i + 1}: unknown op`;
	}
	return null; // full structural validation happens again server-side on save
}

// ── PAS QA API client (scoped QA key auth) ──────────────────────────────────

async function pas<T>(appId: string, qaKey: string, path: string, init: RequestInit = {}): Promise<T> {
	const res = await fetch(`${PAS_API}/v1/apps/${appId}/qa${path}`, {
		...init,
		headers: { "X-QA-Key": qaKey, "Content-Type": "application/json", ...(init.headers ?? {}) },
	});
	if (!res.ok) throw new Error(`PAS ${res.status}: ${await res.text()}`);
	return res.json() as Promise<T>;
}

interface FlowRow { flow_id: string; name: string; spec: TestFlow }
interface RunRow {
	run_id: string; flow_id: string; status: string; trigger_kind: string;
	steps_passed: number | null; steps_total: number | null; failed_step: number | null;
	error: string | null; started_at: number; finished_at: number | null;
}

const watchLink = (appId: string, flowId: string) => `https://${appId}.proappstore.online/__qa/?flow=${flowId}`;
const runnerLink = (appId: string) => `https://${appId}.proappstore.online/__qa/`;

// ── HTTP shell ───────────────────────────────────────────────────────────────

const app = new Hono<{ Bindings: Env }>();

app.get("/", (c) =>
	c.json({
		agent: "qa-automation",
		status: "ok",
		aiBilling: "caller-provided",
		help: "POST /chat { message }. Start with: connect <app-id> <qa-key>",
	}),
);

app.post("/chat", async (c) => {
	const { message, conversation } = await c.req.json<{ message?: string; conversation?: string }>();
	if (!message) return c.json({ error: "message required" }, 400);
	const doId = c.env.AGENT.idFromName(conversation || "main");
	const stub = c.env.AGENT.get(doId);
	return stub.fetch(
		new Request("http://agent/chat", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-CF-Account-ID": c.req.header("X-CF-Account-ID") ?? "",
				"X-CF-AI-Token": c.req.header("X-CF-AI-Token") ?? "",
			},
			body: JSON.stringify({ message }),
		}),
	);
});

export default app;

// ── the agent ────────────────────────────────────────────────────────────────

interface AppConn { appId: string; qaKey: string }

export class AgentDO extends DurableObject<Env> {
	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname !== "/chat" || request.method !== "POST") return new Response("not found", { status: 404 });
		const { message } = await request.json<{ message: string }>();
		const ai = callerAiCredentials(request);
		try {
			const reply = await this.handle(message.trim(), ai);
			return Response.json({ reply });
		} catch (err) {
			return Response.json({ reply: `Something went wrong: ${err instanceof Error ? err.message : String(err)}` });
		}
	}

	private async apps(): Promise<Record<string, AppConn>> {
		return (await this.ctx.storage.get<Record<string, AppConn>>("apps")) ?? {};
	}

	private async resolveApp(named?: string): Promise<AppConn | string> {
		const apps = await this.apps();
		const ids = Object.keys(apps);
		if (named) return apps[named] ?? `I don't have a QA key for "${named}". Connect it first: connect ${named} <qa-key>`;
		if (ids.length === 1) return apps[ids[0]];
		if (ids.length === 0) return "No app connected yet. In the ProAppStore dashboard mint a QA key (POST /v1/apps/<app>/qa/keys), then tell me: connect <app-id> <qa-key>";
		return `Which app? I know: ${ids.join(", ")} — add the app id to your command.`;
	}

	private async handle(message: string, ai: { accountId: string; token: string } | null): Promise<string> {
		const lower = message.toLowerCase();

		// connect <app> <key>
		const connect = message.match(/^connect\s+([a-z0-9-]+)\s+(\S+)$/i);
		if (connect) {
			const [, appId, qaKey] = connect;
			try {
				const { flows } = await pas<{ flows: FlowRow[] }>(appId, qaKey, "/flows");
				const apps = await this.apps();
				apps[appId] = { appId, qaKey };
				await this.ctx.storage.put("apps", apps);
				return `Connected to ${appId} — the key works. ${flows.length} flow(s) on file. Try "flows ${appId}", "run ${appId}", or describe a flow to add ("cover: a student signs in with login X…"). Watch runs live: ${runnerLink(appId)}`;
			} catch (err) {
				return `That key didn't work for ${appId}: ${err instanceof Error ? err.message : err}`;
			}
		}

		// flows [app]
		if (/^flows?\b/.test(lower)) {
			const conn = await this.resolveApp(message.split(/\s+/)[1]);
			if (typeof conn === "string") return conn;
			const [{ flows }, { runs }] = await Promise.all([
				pas<{ flows: FlowRow[] }>(conn.appId, conn.qaKey, "/flows"),
				pas<{ runs: RunRow[] }>(conn.appId, conn.qaKey, "/runs"),
			]);
			if (flows.length === 0) return `${conn.appId} has no flows yet. Describe one and I'll write it (e.g. "cover: the sign-in page shows the student login option").`;
			const latest = new Map<string, RunRow>();
			for (const r of runs) if (!latest.has(r.flow_id)) latest.set(r.flow_id, r);
			return flows.map((f) => {
				const r = latest.get(f.flow_id);
				const status = r ? `${r.status}${r.steps_passed !== null ? ` (${r.steps_passed}/${r.steps_total})` : ""}` : "never run";
				return `• ${f.flow_id} — ${f.name}\n  last: ${status} · watch: ${watchLink(conn.appId, f.flow_id)}`;
			}).join("\n");
		}

		// run [flow-id] [app] / run all
		if (/^run\b/.test(lower)) {
			const parts = message.split(/\s+/).slice(1).filter((p) => p !== "all");
			const apps = await this.apps();
			const appArg = parts.find((p) => apps[p]);
			const flowArg = parts.find((p) => !apps[p]);
			const conn = await this.resolveApp(appArg);
			if (typeof conn === "string") return conn;
			const body = flowArg ? { flowId: flowArg, trigger: "manual" } : { trigger: "manual" };
			const { runs } = await pas<{ runs: { runId: string; flowId: string }[] }>(conn.appId, conn.qaKey, "/runs", {
				method: "POST",
				body: JSON.stringify(body),
			});
			return `Queued ${runs.length} run(s) on the platform's headless browser:\n` +
				runs.map((r) => `• ${r.flowId} — watch a live version anytime: ${watchLink(conn.appId, r.flowId)}`).join("\n") +
				`\nAsk me "status ${conn.appId}" in a minute for results.`;
		}

		// status / results [app]
		if (/^(status|results?)\b/.test(lower)) {
			const conn = await this.resolveApp(message.split(/\s+/)[1]);
			if (typeof conn === "string") return conn;
			const { runs } = await pas<{ runs: RunRow[] }>(conn.appId, conn.qaKey, "/runs");
			if (runs.length === 0) return `No runs yet for ${conn.appId}. Say "run ${conn.appId}" to queue every flow.`;
			const recent = runs.slice(0, 8);
			const lines = recent.map((r) => {
				const when = new Date(r.started_at).toISOString().slice(0, 16).replace("T", " ");
				const core = `• ${r.flow_id}: ${r.status}${r.steps_passed !== null ? ` (${r.steps_passed}/${r.steps_total})` : ""} [${r.trigger_kind}] ${when}`;
				return r.status === "failed" || r.status === "error"
					? `${core}\n  step ${(r.failed_step ?? 0) + 1} failed: ${r.error ?? "unknown"} — inspect: ${watchLink(conn.appId, r.flow_id)}`
					: core;
			});
			const failing = recent.filter((r) => r.status === "failed" || r.status === "error");
			let summary = "";
			if (failing.length > 0 && ai) summary = `\n\n${await this.summarizeFailures(ai, failing)}`;
			return lines.join("\n") + summary;
		}

		// delete flow <id> [app]
		const del = message.match(/^delete\s+flow\s+([a-z0-9-]+)(?:\s+([a-z0-9-]+))?$/i);
		if (del) {
			const conn = await this.resolveApp(del[2]);
			if (typeof conn === "string") return conn;
			await pas(conn.appId, conn.qaKey, `/flows/${del[1]}`, { method: "DELETE" });
			return `Deleted flow ${del[1]} from ${conn.appId}.`;
		}

		if (/^(help|hi|hello|what can you do)/.test(lower)) return HELP;

		// Anything else: treat as a flow description → author a spec (needs AI creds)
		const conn = await this.resolveApp();
		if (typeof conn === "string") return `${conn}\n\n${HELP}`;
		if (!ai) return "I can write that flow, but authoring needs your Workers AI credentials (X-CF-Account-ID / X-CF-AI-Token headers). Deterministic commands (flows / run / status) work without them.";
		return this.authorFlow(ai, conn, message);
	}

	private async authorFlow(ai: { accountId: string; token: string }, conn: AppConn, description: string): Promise<string> {
		const prompt = `Write ONE browser test flow for a ProAppStore web app, as strict JSON (no markdown).
Format: {"id":"kebab-slug","name":"short name","startPath":"/","steps":[...]}
Allowed steps:
{"op":"goto","path":"/x"} {"op":"click","target":T} {"op":"clickPoint","xPct":0-100,"yPct":0-100}
{"op":"fill","target":T,"value":"text"} {"op":"press","key":"Enter"} {"op":"expectVisible","target":T}
{"op":"expectText","text":"..."} {"op":"waitFor","ms":500} {"op":"screenshot"}
Target T sets exactly ONE of: {"label":"aria-label"} | {"text":"visible text"} | {"selector":"css"}.
QA mindset: prefer expects over blind waits; include at least one negative/edge check when the description allows.
The flow must work for a signed-out visitor unless the description includes credentials.

Description: ${description}`;
		const raw = await this.runAi(ai, prompt);
		const json = raw.match(/\{[\s\S]*\}/)?.[0];
		if (!json) return `I couldn't produce a valid flow from that. Model said:\n${raw.slice(0, 400)}`;
		let flow: TestFlow;
		try {
			flow = JSON.parse(json) as TestFlow;
		} catch {
			return `The model produced invalid JSON. Try rephrasing the flow description.`;
		}
		const problem = validateFlow(flow);
		if (problem) return `The generated flow didn't validate (${problem}). Try rephrasing.`;
		try {
			await pas(conn.appId, conn.qaKey, `/flows/${flow.id}`, { method: "PUT", body: JSON.stringify({ flow }) });
		} catch (err) {
			return `The platform rejected the flow: ${err instanceof Error ? err.message : err}`;
		}
		const steps = flow.steps.map((s, i) => `  ${i + 1}. ${describeStep(s)}`).join("\n");
		return `Saved flow "${flow.name}" (${flow.id}) to ${conn.appId} — it lives in the platform, not your repo.\n${steps}\nRun it: "run ${flow.id}" · watch it live: ${watchLink(conn.appId, flow.id)}`;
	}

	private async summarizeFailures(ai: { accountId: string; token: string }, failing: RunRow[]): Promise<string> {
		const detail = failing.map((r) => `${r.flow_id}: step ${(r.failed_step ?? 0) + 1} — ${r.error}`).join("\n");
		const raw = await this.runAi(ai, `As a QA engineer, in 2-3 sentences: likely cause + what to check first.\nFailures:\n${detail}`);
		return `Diagnosis: ${raw.trim().slice(0, 500)}`;
	}

	private async runAi(ai: { accountId: string; token: string }, prompt: string): Promise<string> {
		const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ai.accountId}/ai/run/${MODEL}`, {
			method: "POST",
			headers: { Authorization: `Bearer ${ai.token}`, "Content-Type": "application/json" },
			body: JSON.stringify({ messages: [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: prompt }] }),
		});
		if (!res.ok) throw new Error(`Workers AI ${res.status}`);
		const data = (await res.json()) as { result?: { response?: string }; response?: string };
		return data.result?.response ?? data.response ?? "";
	}
}

function describeStep(s: Step): string {
	const t = "target" in s && s.target ? s.target.label ?? s.target.text ?? s.target.selector ?? "" : "";
	switch (s.op) {
		case "goto": return `go to ${s.path}`;
		case "click": return `click "${t}"`;
		case "clickPoint": return `click at ${s.xPct}%, ${s.yPct}%`;
		case "fill": return `type into "${t}"`;
		case "press": return `press ${s.key}`;
		case "expectVisible": return `expect "${t}" visible`;
		case "expectText": return `expect text "${s.text}"`;
		case "waitFor": return s.target ? `wait for "${t}"` : `wait ${s.ms}ms`;
		case "screenshot": return "screenshot";
	}
}

const HELP = `I'm your QA engineer for ProAppStore apps. Commands:
• connect <app-id> <qa-key> — link an app (mint the key: POST /v1/apps/<app>/qa/keys as the owner)
• flows [app] — list flows with last results and watch links
• run [flow-id] [app] — queue headless runs on the platform
• status [app] — recent results with failure diagnosis
• delete flow <id> [app]
• …or just DESCRIBE a user flow ("cover: the sign-in page shows the student option") and I'll write, validate, and save it — specs live in the platform, never in your repo. Watch any flow run live at https://<app>.proappstore.online/__qa/`;

function callerAiCredentials(request: Request): { accountId: string; token: string } | null {
	const accountId = request.headers.get("X-CF-Account-ID");
	const token = request.headers.get("X-CF-AI-Token");
	return accountId && token ? { accountId, token } : null;
}
