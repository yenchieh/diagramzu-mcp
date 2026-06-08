#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildServer } from "./buildServer.js";
import { DiagramzuClient } from "./client.js";

const baseUrl = (process.env.DIAGRAMZU_BASE_URL ?? "").replace(/\/$/, "");
const token = process.env.DIAGRAMZU_API_TOKEN ?? "";
const spaceId = process.env.DIAGRAMZU_SPACE_ID ?? "";

if (!baseUrl || !token || !spaceId) {
  console.error(
    "[diagramzu-mcp] missing required env: DIAGRAMZU_BASE_URL, DIAGRAMZU_API_TOKEN, DIAGRAMZU_SPACE_ID",
  );
  process.exit(1);
}

// stdio single-space use-case: REST and user-facing URLs are the same host,
// so siteBaseUrl defaults to baseUrl.
const client = new DiagramzuClient({ baseUrl, token, spaceId });

const server = buildServer(client);

await server.connect(new StdioServerTransport());
