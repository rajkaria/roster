import { gitEnv, runGit } from "./index.ts";

export interface IsolationCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface IsolationProof {
  ok: boolean;
  checks: IsolationCheck[];
}

/** Blob ids reachable from any ref in `sourceRepo` but not from `commitSha`. */
function futureBlobs(sourceRepo: string, commitSha: string): string[] {
  const objs = runGit(sourceRepo, ["rev-list", "--objects", "--all", `^${commitSha}`]);
  const ids = objs
    .split("\n")
    .map((l) => l.split(" ")[0]!)
    .filter(Boolean);
  if (ids.length === 0) return [];
  const r = Bun.spawnSync(["git", "cat-file", "--batch-check=%(objecttype) %(objectname)"], {
    cwd: sourceRepo,
    env: gitEnv(),
    stdin: new TextEncoder().encode(ids.join("\n") + "\n"),
  });
  return r.stdout
    .toString()
    .split("\n")
    .filter((l) => l.startsWith("blob "))
    .map((l) => l.slice(5));
}

export async function proveIsolation(
  sandboxPath: string,
  sourceRepo: string,
  commitSha: string,
): Promise<IsolationProof> {
  const checks: IsolationCheck[] = [];
  const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });

  const commits = runGit(sandboxPath, ["log", "--all", "--format=%H"]).split("\n").filter(Boolean);
  add("single-commit", commits.length === 1, `${commits.length} commit(s) in git log --all`);

  const refs = runGit(sandboxPath, ["for-each-ref", "--format=%(refname)"]).split("\n").filter(Boolean);
  add("single-ref", refs.length === 1, `${refs.length} ref(s)`);

  const future = futureBlobs(sourceRepo, commitSha);
  const leaked = future.filter(
    (id) => Bun.spawnSync(["git", "cat-file", "-e", id], { cwd: sandboxPath, env: gitEnv() }).exitCode === 0,
  );
  add(
    "no-future-blobs",
    leaked.length === 0,
    `${leaked.length} of ${future.length} future blob(s) present in sandbox store`,
  );

  const remotes = runGit(sandboxPath, ["remote"]).split("\n").filter(Boolean);
  add("no-remotes", remotes.length === 0, `${remotes.length} remote(s)`);

  // HEAD and the branch each keep their own reflog; neither may have more than the base entry.
  const reflogLens = ["HEAD", ...refs].map(
    (r) => runGit(sandboxPath, ["reflog", "show", r]).split("\n").filter(Boolean).length,
  );
  add("reflog-base-only", reflogLens.every((n) => n <= 1), `reflog lengths ${reflogLens.join(",")}`);

  return { ok: checks.every((c) => c.ok), checks };
}
