import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import E from "../setups/candidates/E.json";
import { childEnv, parseResult } from "../src/harness/claude.ts";
import { providerEnv, type CandidateSetup } from "../src/harness/provider.ts";

const setup = (env: Record<string, string>, id = "X"): CandidateSetup => ({ id, env });

describe("providerEnv: ${VAR} resolution", () => {
  test("literal values pass through unchanged", () => {
    expect(providerEnv(setup({ ANTHROPIC_MODEL: "deepseek-flash" }), {})).toEqual({ ANTHROPIC_MODEL: "deepseek-flash" });
  });

  test("a whole-value reference resolves from the given env", () => {
    const out = providerEnv(setup({ ANTHROPIC_AUTH_TOKEN: "${DEEPSEEK_API_KEY}" }), { DEEPSEEK_API_KEY: "k-123" });
    expect(out).toEqual({ ANTHROPIC_AUTH_TOKEN: "k-123" });
  });

  test("a reference embedded in a larger value resolves too", () => {
    const out = providerEnv(setup({ X: "pre-${A}-mid-${B}" }), { A: "1", B: "2" });
    expect(out.X).toBe("pre-1-mid-2");
  });

  test("a missing variable throws with its name", () => {
    expect(() => providerEnv(setup({ ANTHROPIC_AUTH_TOKEN: "${DEEPSEEK_API_KEY}" }, "E"), {})).toThrow(/DEEPSEEK_API_KEY/);
  });

  test("an empty variable counts as missing", () => {
    expect(() => providerEnv(setup({ ANTHROPIC_AUTH_TOKEN: "${DEEPSEEK_API_KEY}" }), { DEEPSEEK_API_KEY: "" })).toThrow(
      /DEEPSEEK_API_KEY/,
    );
  });

  test("the error never prints a resolved value", () => {
    let msg = "";
    try {
      providerEnv(setup({ A: "${MISSING_VAR}", B: "${PRESENT}" }), { PRESENT: "super-secret-value" });
    } catch (e) {
      msg = String(e);
    }
    expect(msg).toMatch(/MISSING_VAR/);
    expect(msg).not.toContain("super-secret-value");
  });

  test("a setup with no env resolves to an empty record", () => {
    expect(providerEnv({ id: "A" }, {})).toEqual({});
  });
});

describe("providerEnv: setup E", () => {
  test("resolves the DeepSeek endpoint, token and model names", () => {
    const out = providerEnv(E, { DEEPSEEK_API_KEY: "k-test" });
    expect(out.ANTHROPIC_BASE_URL).toBe("https://api.deepseek.com/anthropic");
    expect(out.ANTHROPIC_AUTH_TOKEN).toBe("k-test");
    expect(out.ANTHROPIC_MODEL).toBe("deepseek-flash");
    expect(out.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("deepseek-flash");
    expect(out.CLAUDE_CODE_SUBAGENT_MODEL).toBe("deepseek-flash");
  });

  test("setup E without DEEPSEEK_API_KEY throws, naming the variable", () => {
    expect(() => providerEnv(E, {})).toThrow(/DEEPSEEK_API_KEY/);
  });
});

describe("providerEnv: host credentials", () => {
  test("a host ANTHROPIC_API_KEY is blanked when the base URL is not Anthropic's", () => {
    const out = providerEnv(E, { DEEPSEEK_API_KEY: "k-test", ANTHROPIC_API_KEY: "sk-ant-host" });
    expect(out.ANTHROPIC_API_KEY).toBe("");
    expect(JSON.stringify(out)).not.toContain("sk-ant-host");
  });

  test("the host key is not blanked when the base URL is Anthropic's own", () => {
    const out = providerEnv({ id: "A", env: { ANTHROPIC_BASE_URL: "https://api.anthropic.com" } }, {});
    expect(out).not.toHaveProperty("ANTHROPIC_API_KEY");
  });

  test("a setup that sets ANTHROPIC_API_KEY itself keeps its own value", () => {
    const out = providerEnv(setup({ ANTHROPIC_BASE_URL: "https://proxy.example", ANTHROPIC_API_KEY: "${MY_KEY}" }), {
      MY_KEY: "mine",
    });
    expect(out.ANTHROPIC_API_KEY).toBe("mine");
  });

  test("the result is what claude.ts passes to the child, and host session variables are still scrubbed", () => {
    const env = providerEnv(E, { DEEPSEEK_API_KEY: "k-test" });
    const child = childEnv({ ...env, CLAUDECODE: "1" });
    expect(child.ANTHROPIC_AUTH_TOKEN).toBe("k-test");
    expect(child).not.toHaveProperty("CLAUDECODE");
  });
});

// Opt-in: ROSTER_LIVE=1 DEEPSEEK_API_KEY=... bun test tests/provider.test.ts
const LIVE = process.env.ROSTER_LIVE === "1" && !!process.env.DEEPSEEK_API_KEY;

describe("live: setup E through claude -p", () => {
  test.skipIf(!LIVE)(
    "a trivial prompt returns a result event",
    async () => {
      const cwd = mkdtempSync(join(tmpdir(), "roster-live-"));
      const env = childEnv(providerEnv(E, process.env));
      const p = Bun.spawn(
        [
          "claude",
          "-p",
          "Reply with the single word OK.",
          "--model",
          "deepseek-flash",
          "--output-format",
          "json",
          "--max-turns",
          "2",
          "--tools",
          "",
          "--setting-sources",
          "project",
          "--strict-mcp-config",
          "--disable-slash-commands",
          "--no-session-persistence",
        ],
        { cwd, env, stdout: "pipe", stderr: "pipe" },
      );
      const stdout = await new Response(p.stdout).text();
      await p.exited;
      expect(parseResult(stdout)?.type).toBe("result");
    },
    120_000,
  );
});
