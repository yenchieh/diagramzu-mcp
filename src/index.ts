#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildServer } from "./buildServer.js";
import { DiagramzuClient, type DiagramzuConfig } from "./client.js";

const baseUrl = (process.env.DIAGRAMZU_BASE_URL ?? "").replace(/\/$/, "");
const token = process.env.DIAGRAMZU_API_TOKEN ?? "";
// CARD 160: DIAGRAMZU_SPACE_ID is now OPTIONAL. Unset, the token's own default
// workspace is used — the one chosen when the token was minted — and an
// account-scoped token reaches the rest through each tool's `space` argument.
// Set, it pins the default workspace for this process, which is how an
// existing config keeps behaving exactly as it did.
const spaceId = process.env.DIAGRAMZU_SPACE_ID ?? "";

if (!baseUrl || !token) {
  console.error(
    "[diagramzu-mcp] missing required env: DIAGRAMZU_BASE_URL, DIAGRAMZU_API_TOKEN" +
      " (DIAGRAMZU_SPACE_ID is optional — the token's default workspace is used when it is unset)",
  );
  process.exit(1);
}

/**
 * Resolve the starting workspace from the token itself.
 *
 * This is the SAME call mcp-svc makes per request (GET /api/token/whoami), and
 * it is the only way a stdio process can learn the token's default workspace,
 * its scope, and whether that default is still reachable. It runs ONCE at
 * startup, not per tool call: a stdio server serves one token for its life.
 *
 * A pinned DIAGRAMZU_SPACE_ID still wins for the workspace itself, but whoami
 * is called anyway, for `scope`: without it an account-scoped token would be
 * told it is single-space and `list_spaces` would say so, wrongly.
 */
async function resolveConfig(): Promise<DiagramzuConfig> {
  // CARD 161: a failed check is REPORTED, never fatal. Registries (Glama)
  // install this package and list its tools with placeholder credentials, and
  // a client may start us while offline; 0.10 exited here and both broke. We
  // start with the pinned space (0.0.9's behaviour) or none, and a call that
  // lands on a missing default says so (tools.ts `scoped()`).
  const fallback: DiagramzuConfig = { baseUrl, token, spaceId };
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/api/token/whoami`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch (err) {
    console.error(`[diagramzu-mcp] token check failed (${String(err)}); starting anyway.`);
    return fallback;
  }
  if (!res.ok) {
    console.error(
      `[diagramzu-mcp] token check failed (HTTP ${res.status}). The token may be revoked or expired,` +
        " or its owner may no longer be a member of any workspace. Starting anyway; tool calls will report it.",
    );
    return fallback;
  }
  const who = (await res.json()) as {
    spaceId?: string;
    scope?: "space" | "account";
    spaceName?: string;
    defaultReachable?: boolean;
  };
  const resolved = spaceId || who.spaceId || "";
  if (!resolved) {
    console.error("[diagramzu-mcp] the API did not return a default workspace for this token.");
  }
  const pinnedElsewhere = resolved !== who.spaceId;
  return {
    baseUrl,
    token,
    spaceId: resolved,
    // Only name the workspace when whoami's id is the one we are using. A
    // pinned DIAGRAMZU_SPACE_ID pointing somewhere else would otherwise be
    // labelled with the DEFAULT workspace's name in every tool result.
    ...(who.spaceName !== undefined && !pinnedElsewhere ? { spaceName: who.spaceName } : {}),
    ...(who.scope === undefined ? {} : { scope: who.scope }),
    // whoami's flag describes the token's DEFAULT workspace. It says nothing
    // about a pinned one, so it is only carried over when they are the same.
    ...(who.defaultReachable === undefined || pinnedElsewhere
      ? {}
      : { defaultReachable: who.defaultReachable }),
  };
}

// stdio single-host use-case: REST and user-facing URLs are the same host, so
// siteBaseUrl defaults to baseUrl.
const client = new DiagramzuClient(await resolveConfig());

const server = buildServer(client);

await server.connect(new StdioServerTransport());
