export interface PrBodyTask {
  id: string;
  incumbentPass: boolean;
  candidatePass: boolean;
  costUsd: number | null;
  traceUrl?: string;
  entireUrl?: string;
}

export interface PrBodyInput {
  repo: string;
  incumbent: string;
  promoted: string;
  tasks: PrBodyTask[];
  rejected: { candidate: string; reasons: string[] }[];
  evidenceLevel: 'B' | 'C';
}

const mark = (pass: boolean): string => (pass ? '✓' : '✗');

const cell = (text: string): string => text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

const cost = (usd: number | null): string =>
  usd === null || !Number.isFinite(usd) ? 'n/a' : usd.toFixed(2);

export function renderPrBody(input: PrBodyInput): string {
  const { repo, incumbent, promoted, tasks, rejected, evidenceLevel } = input;
  const n = tasks.length;
  const candidatePasses = tasks.filter((t) => t.candidatePass).length;
  const incumbentPasses = tasks.filter((t) => t.incumbentPass).length;

  const lines: string[] = [];

  lines.push('## Summary', '');
  lines.push(`Roster promotes setup \`${promoted}\` over incumbent \`${incumbent}\` in \`${repo}\`.`, '');
  lines.push(`Evidence level: ${evidenceLevel}`, '');
  lines.push(`${candidatePasses} of ${n} tasks passed (incumbent ${incumbentPasses} of ${n})`, '');

  lines.push('## Evidence', '');
  lines.push('| Task | Incumbent | Promoted | Cost (USD) |');
  lines.push('| --- | --- | --- | --- |');
  for (const t of tasks) {
    lines.push(`| ${cell(t.id)} | ${mark(t.incumbentPass)} | ${mark(t.candidatePass)} | ${cost(t.costUsd)} |`);
  }
  lines.push('');

  lines.push('## Rejected candidates', '');
  if (rejected.length === 0) {
    lines.push('None');
  } else {
    for (const r of rejected) {
      lines.push(`- \`${r.candidate}\``);
      if (r.reasons.length === 0) {
        lines.push('  - No reason recorded');
      } else {
        for (const reason of r.reasons) lines.push(`  - ${reason.replace(/\r?\n/g, ' ')}`);
      }
    }
  }
  lines.push('');

  lines.push('## Links', '');
  const links: string[] = [];
  for (const t of tasks) {
    if (t.traceUrl) links.push(`- ${t.id}: [trace](${t.traceUrl})`);
    if (t.entireUrl) links.push(`- ${t.id}: [entire](${t.entireUrl})`);
  }
  if (links.length === 0) lines.push('None');
  else lines.push(...links);
  lines.push('');

  return lines.join('\n');
}
