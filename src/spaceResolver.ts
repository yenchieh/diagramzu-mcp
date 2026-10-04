import type { TokenSpace } from "./client.js";

/**
 * Card 160 — resolving the per-call `space` argument to exactly one Space.
 *
 * A PURE module with no client and no I/O, because the matching rule is the
 * part an agent's mistake lands on and the part a mutant can quietly widen.
 * `tools.ts` does the fetching; this decides.
 *
 * THE ORDER IS id → slug → exact case-insensitive name, and it is not
 * arbitrary:
 *
 *   - an id is opaque and unique, so it can never be ambiguous;
 *   - a slug is unique per deployment, so it cannot be either;
 *   - a NAME is neither. Two Spaces may legitimately be called "Design", and
 *     an agent that guesses from conversation will reach for the name first.
 *     So a name that matches more than one Space is an ERROR listing the
 *     candidates, never a pick.
 *
 * Case-insensitivity applies to the NAME only. Ids and slugs are data, matched
 * byte-exactly for the same reason card 125 leaves share slugs alone: a
 * case-folded id match would make two distinct ids collide on a deployment
 * that ever issues mixed-case ones.
 *
 * Matching is EXACT, never substring. A substring rule would make `space:
 * "ops"` silently act in "DevOps Platform" — the single worst failure this
 * feature can have, because the agent reports success and the write lands in
 * someone else's workspace.
 */

export type SpaceResolution =
  | { ok: true; space: TokenSpace }
  | { ok: false; error: string };

/** Normalises a name for comparison: trimmed, case-folded. */
function foldName(s: string): string {
  // toLowerCase then toUpperCase: a single fold is not symmetric for every
  // script, and we only need the two sides to agree with each other.
  return s.trim().toLowerCase();
}

/** Renders the reachable Spaces for an error message, one per line. */
export function describeSpaces(spaces: TokenSpace[]): string {
  if (spaces.length === 0) return "(none)";
  return spaces
    .map((s) => `- ${s.name} (id: ${s.id}, slug: ${s.slug})${s.isDefault ? " [default]" : ""}`)
    .join("\n");
}

/**
 * Resolve `arg` against the Spaces this token can reach.
 *
 * Returns an error — never a guess — when the argument matches nothing, or
 * when it matches several by name.
 */
export function resolveSpace(arg: string, spaces: TokenSpace[]): SpaceResolution {
  const raw = arg.trim();
  if (!raw) {
    return {
      ok: false,
      error: `\`space\` was empty. Omit it to use the default workspace, or pass one of:\n${describeSpaces(spaces)}`,
    };
  }

  const byId = spaces.find((s) => s.id === raw);
  if (byId) return { ok: true, space: byId };

  const bySlug = spaces.find((s) => s.slug === raw);
  if (bySlug) return { ok: true, space: bySlug };

  const folded = foldName(raw);
  const byName = spaces.filter((s) => foldName(s.name) === folded);
  if (byName.length === 1) return { ok: true, space: byName[0]! };
  if (byName.length > 1) {
    return {
      ok: false,
      error:
        `\`space: "${raw}"\` matches ${byName.length} workspaces by name. ` +
        `Pass the id or slug instead:\n${describeSpaces(byName)}`,
    };
  }

  return {
    ok: false,
    error:
      `No workspace matches \`space: "${raw}"\`. ` +
      `This token can reach:\n${describeSpaces(spaces)}\n` +
      `Pass an id, a slug, or an exact workspace name, or omit \`space\` for the default.`,
  };
}
