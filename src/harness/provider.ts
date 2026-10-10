// Provider env for candidate setups (DESIGN.md §"Candidate generation", §"Harness adapters").
//
//   const env = providerEnv(setup, process.env);   // pass as the runClaude `env` option
//
// A setup's `env` values may hold ${VAR} references, filled from the env given here. A missing or empty
// variable throws with its name. Values are never printed.

const REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
const ANTHROPIC_HOST = "api.anthropic.com";

/** The fields of a setups/candidates/*.json file that this module reads. */
export interface CandidateSetup {
  id: string;
  env?: Record<string, string>;
}

/**
 * Credentials Claude Code would send to ANTHROPIC_BASE_URL. Blanked when the base URL is not Anthropic's,
 * so a host key never reaches a third-party endpoint.
 */
const HOST_CREDENTIALS = ["ANTHROPIC_API_KEY"];

function isAnthropicUrl(url: string): boolean {
  try {
    return new URL(url).hostname === ANTHROPIC_HOST;
  } catch {
    return false;
  }
}

export function providerEnv(setup: CandidateSetup, env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(setup.env ?? {})) {
    out[key] = raw.replace(REF, (_, name: string) => {
      const v = env[name];
      if (v === undefined || v === "") throw new Error(`setup ${setup.id}: env var ${name} is not set (needed by ${key})`);
      return v;
    });
  }
  const base = out.ANTHROPIC_BASE_URL;
  if (base !== undefined && !isAnthropicUrl(base)) {
    for (const k of HOST_CREDENTIALS) if (!(k in out)) out[k] = "";
  }
  return out;
}
