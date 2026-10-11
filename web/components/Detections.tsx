import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Empty, Section } from "./Sections";

export interface DetectionRow {
  id: string;
  setup?: string;
  task?: string;
  detail: string;
}

const DATA = join(process.cwd(), "public", "data");

/** Detections from a review's decisions.json (`detections`), else its detections.json. null when neither exists. */
export function loadDetections(owner: string, repo: string): DetectionRow[] | null {
  for (const c of [`${owner}__${repo}`, `${owner}-${repo}`, join(owner, repo)]) {
    const dir = join(DATA, c);
    if (!existsSync(join(dir, "review.json"))) continue;
    for (const name of ["decisions.json", "detections.json"]) {
      const file = join(dir, name);
      if (!existsSync(file)) continue;
      try {
        const v = JSON.parse(readFileSync(file, "utf8"));
        const list = Array.isArray(v) ? v : v?.detections;
        if (Array.isArray(list)) return list as DetectionRow[];
      } catch {
        // unreadable: try the next file
      }
    }
  }
  return null;
}

export function Detections({ rows }: { rows: DetectionRow[] | null }) {
  if (rows === null) return null;
  return (
    <Section title="Detections" level="B">
      {rows.length === 0 ? (
        <Empty>No detections fired.</Empty>
      ) : (
        <div className="scroll">
          <table>
            <thead>
              <tr><th>Detection</th><th>Setup</th><th>Task</th><th>Detail</th></tr>
            </thead>
            <tbody>
              {rows.map((d, i) => (
                <tr key={`${d.id}-${d.setup ?? ""}-${d.task ?? ""}-${i}`}>
                  <td><span className="badge">{d.id}</span></td>
                  <td>{d.setup ?? <span className="na">n/a</span>}</td>
                  <td>{d.task ?? <span className="na">n/a</span>}</td>
                  <td>{d.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}
