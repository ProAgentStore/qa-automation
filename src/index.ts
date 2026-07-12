/**
 * QA Automation — a ProAgentStore agent with a QA mindset
 * (ProAgentStore/platform#14, consumes proappstore-online/platform#38).
 * See README. Deterministic commands need no AI credentials; authoring and
 * failure summaries use caller-provided Workers AI.
 */
export { default } from "./agent.js";
// wrangler.toml binds the DO as GeneratedAgentDO (migration tag v1; renaming
// a DO class is a breaking migration, so export under the scaffold's name).
export { AgentDO as GeneratedAgentDO } from "./agent.js";
