// Library entry for @diagramzu/mcp — the reusable, transport-agnostic surface
// consumed by the standalone remote MCP service (services/mcp-svc) and any other
// in-process host. The stdio CLI lives in ./index.ts (bin), which imports from
// here; importing this module has NO side effects (no env reads, no process.exit,
// no transport connect).
export { buildServer } from "./buildServer.js";
export { DiagramzuClient } from "./client.js";
export type {
  DiagramzuConfig,
  Diagram,
  DiagramSummary,
  FolderRow,
  DeckSummary,
  DeckSlideRef,
  DeckDetail,
  CreateDeckInput,
  UpdateDeckInput,
} from "./client.js";
export { registerTools } from "./tools.js";
export { SERVER_INSTRUCTIONS } from "./instructions.js";
