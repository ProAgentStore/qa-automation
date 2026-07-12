// The scaffold's wrangler.toml binds the Durable Object as GeneratedAgentDO
// (migration tag v1 — renaming a DO class is a breaking migration, so we
// export our implementation under that name instead).
export { AgentDO as GeneratedAgentDO } from "./index.js";
