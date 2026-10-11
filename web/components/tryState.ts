// Pure state mapping for the /try form. Kept apart from TryForm.tsx so tests can import it without JSX.

export type TryState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "invalid"; message: string }
  | { kind: "rate_limited"; message: string }
  | { kind: "cached"; href: string; label: string }
  | { kind: "queued"; command: string }
  | { kind: "error"; message: string };

/** `owner/repo` from a pasted reference, using the same shapes the API accepts. Null when it is not one. */
export function repoFromInput(input: string): { owner: string; repo: string } | null {
  const raw = input.trim().replace(/\/+$/, "");
  const m = /^(?:https:\/\/github\.com\/)?([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9._-]+?)(?:\.git)?$/.exec(raw);
  return m?.[1] && m[2] ? { owner: m[1], repo: m[2] } : null;
}

/** Maps an API status and body to what the page shows. */
export function mapResponse(status: number, body: unknown, input: string): TryState {
  const err = typeof (body as { error?: unknown } | null)?.error === "string" ? (body as { error: string }).error : "";
  const ref = repoFromInput(input);
  if (status === 400) return { kind: "invalid", message: err || "That is not a GitHub repository URL." };
  if (status === 429) return { kind: "rate_limited", message: "Try again in a minute" };
  if (status === 200 && (body as { cached?: unknown } | null)?.cached === true && ref) {
    return { kind: "cached", href: `/r/${ref.owner}/${ref.repo}`, label: `${ref.owner}/${ref.repo}` };
  }
  if (status === 202 && ref) {
    return { kind: "queued", command: `bun src/cli.ts review https://github.com/${ref.owner}/${ref.repo} --observational` };
  }
  return { kind: "error", message: "Something went wrong. Nothing was reviewed." };
}
