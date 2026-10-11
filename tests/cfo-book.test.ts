import { expect, test } from "bun:test";
import { buildBook } from "../src/cfo/book";

const assumptions = { engineerMonthlyLoadedUsd: 15000, scaleSessionsPerWeek: 70 };
const setups = [
  { id: "a", label: "A", costUsd: 30, sessions: 10, survivingChanges: 6, unattendedShare: 0.5555 },
  { id: "b", label: "B", costUsd: null, sessions: 4, survivingChanges: 0, unattendedShare: 0 },
  { id: "c", label: "C", costUsd: 10, sessions: 5, survivingChanges: 0, unattendedShare: 1 },
];

test("department rows scale to 30 days", () => {
  const { department } = buildBook({ periodDays: 15, setups, promoted: "a", assumptions });
  expect(department[0]).toEqual({
    setup: "a",
    label: "A",
    monthlySpendUsd: 60,
    survivingChangesPerMonth: 12,
    costPerSurvivingChangeUsd: 5,
    unattendedPct: 55.6,
  });
  expect(department[1]?.monthlySpendUsd).toBeNull();
  expect(department[1]?.costPerSurvivingChangeUsd).toBeNull();
  expect(department[2]?.monthlySpendUsd).toBe(20);
  expect(department[2]?.costPerSurvivingChangeUsd).toBeNull();
});

test("scenario uses the promoted setup's per-session rates", () => {
  const { scenario, assumptions: echoed } = buildBook({ periodDays: 30, setups, promoted: "a", assumptions });
  expect(scenario.hireMonthlyUsd).toBe(15000);
  expect(scenario.scaleMonthlyUsd).toBe(900);
  expect(scenario.scaleSurvivingChangesPerMonth).toBeCloseTo(180, 9);
  expect(echoed).toEqual(assumptions);
});

test("null promoted gives null scale fields", () => {
  const { scenario } = buildBook({ periodDays: 30, setups, promoted: null, assumptions });
  expect(scenario.scaleMonthlyUsd).toBeNull();
  expect(scenario.scaleSurvivingChangesPerMonth).toBeNull();
  expect(scenario.hireMonthlyUsd).toBe(15000);
});

test("promoted setup with null cost gives null scale spend", () => {
  const { scenario } = buildBook({ periodDays: 30, setups, promoted: "b", assumptions });
  expect(scenario.scaleMonthlyUsd).toBeNull();
  expect(scenario.scaleSurvivingChangesPerMonth).toBe(0);
});
