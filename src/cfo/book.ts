export type BookSetup = {
  id: string;
  label: string;
  costUsd: number | null;
  sessions: number;
  survivingChanges: number;
  unattendedShare: number;
};

export type BookInput = {
  periodDays: number;
  setups: BookSetup[];
  promoted: string | null;
  assumptions: { engineerMonthlyLoadedUsd: number; scaleSessionsPerWeek: number };
};

export type BookOutput = {
  department: {
    setup: string;
    label: string;
    monthlySpendUsd: number | null;
    survivingChangesPerMonth: number;
    costPerSurvivingChangeUsd: number | null;
    unattendedPct: number;
  }[];
  scenario: {
    hireMonthlyUsd: number;
    scaleMonthlyUsd: number | null;
    scaleSurvivingChangesPerMonth: number | null;
  };
  assumptions: Record<string, number>;
};

const cents = (n: number): number => Math.round(n * 100) / 100;
const tenth = (n: number): number => Math.round(n * 10) / 10;

export function buildBook(input: BookInput): BookOutput {
  const { periodDays, setups, promoted, assumptions } = input;
  const toMonth = (v: number): number => (v * 30) / periodDays;

  const department = setups.map((s) => {
    const spend = s.costUsd === null ? null : toMonth(s.costUsd);
    const surviving = toMonth(s.survivingChanges);
    const costPer =
      spend === null || s.survivingChanges === 0 ? null : cents(spend / surviving);
    return {
      setup: s.id,
      label: s.label,
      monthlySpendUsd: spend === null ? null : cents(spend),
      survivingChangesPerMonth: surviving,
      costPerSurvivingChangeUsd: costPer,
      unattendedPct: tenth(s.unattendedShare * 100),
    };
  });

  const p = promoted === null ? undefined : setups.find((s) => s.id === promoted);
  const sessionsPerMonth = assumptions.scaleSessionsPerWeek * (30 / 7);
  const canScale = p !== undefined && p.sessions > 0;

  return {
    department,
    scenario: {
      hireMonthlyUsd: cents(assumptions.engineerMonthlyLoadedUsd),
      scaleMonthlyUsd:
        canScale && p.costUsd !== null
          ? cents((p.costUsd / p.sessions) * sessionsPerMonth)
          : null,
      scaleSurvivingChangesPerMonth: canScale
        ? (p.survivingChanges / p.sessions) * sessionsPerMonth
        : null,
    },
    assumptions: { ...assumptions },
  };
}
