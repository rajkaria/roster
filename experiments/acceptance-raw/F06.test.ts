import { describe, expect, it } from "bun:test";
import { buildBook } from "../../../src/cfo/book.ts";

describe("buildBook", () => {
  it("computes monthly department rows, rounds money and percentages, and handles null promotion", () => {
    const result = buildBook({
      periodDays: 7,
      setups: [
        {
          id: "setup-a",
          label: "Setup A",
          costUsd: 100,
          sessions: 5,
          survivingChanges: 7,
          unattendedShare: 0.125,
        },
      ],
      promoted: null,
      assumptions: {
        engineerMonthlyLoadedUsd: 12345.678,
        scaleSessionsPerWeek: 7,
      },
    });

    expect(result.department).toEqual([
      {
        setup: "setup-a",
        label: "Setup A",
        monthlySpendUsd: 428.57,
        survivingChangesPerMonth: 30,
        costPerSurvivingChangeUsd: 14.29,
        unattendedPct: 12.5,
      },
    ]);
    expect(result.scenario).toEqual({
      hireMonthlyUsd: 12345.68,
      scaleMonthlyUsd: null,
      scaleSurvivingChangesPerMonth: null,
    });
    expect(result.assumptions).toEqual({
      engineerMonthlyLoadedUsd: 12345.678,
      scaleSessionsPerWeek: 7,
    });
  });

  it("computes the scenario from the promoted setup's per-session cost and surviving-change rate", () => {
    const result = buildBook({
      periodDays: 30,
      setups: [
        {
          id: "old",
          label: "Old",
          costUsd: 1000,
          sessions: 20,
          survivingChanges: 10,
          unattendedShare: 0.5,
        },
        {
          id: "new",
          label: "New",
          costUsd: 500,
          sessions: 5,
          survivingChanges: 3,
          unattendedShare: 0.25,
        },
      ],
      promoted: "new",
      assumptions: {
        engineerMonthlyLoadedUsd: 9000,
        scaleSessionsPerWeek: 7,
      },
    });

    expect(result.department).toEqual([
      {
        setup: "old",
        label: "Old",
        monthlySpendUsd: 1000,
        survivingChangesPerMonth: 10,
        costPerSurvivingChangeUsd: 100,
        unattendedPct: 50.0,
      },
      {
        setup: "new",
        label: "New",
        monthlySpendUsd: 500,
        survivingChangesPerMonth: 3,
        costPerSurvivingChangeUsd: 166.67,
        unattendedPct: 25.0,
      },
    ]);
    expect(result.scenario).toEqual({
      hireMonthlyUsd: 9000,
      scaleMonthlyUsd: 3000,
      scaleSurvivingChangesPerMonth: 18,
    });
    expect(result.assumptions).toEqual({
      engineerMonthlyLoadedUsd: 9000,
      scaleSessionsPerWeek: 7,
    });
  });

  it("rounds scenario money and computes exact surviving changes from the promoted setup", () => {
    const result = buildBook({
      periodDays: 30,
      setups: [
        {
          id: "p",
          label: "Promoted",
          costUsd: 100.01,
          sessions: 7,
          survivingChanges: 7,
          unattendedShare: 0.1,
        },
      ],
      promoted: "p",
      assumptions: {
        engineerMonthlyLoadedUsd: 5000,
        scaleSessionsPerWeek: 7,
      },
    });

    expect(result.department).toEqual([
      {
        setup: "p",
        label: "Promoted",
        monthlySpendUsd: 100.01,
        survivingChangesPerMonth: 7,
        costPerSurvivingChangeUsd: 14.29,
        unattendedPct: 10.0,
      },
    ]);
    expect(result.scenario).toEqual({
      hireMonthlyUsd: 5000,
      scaleMonthlyUsd: 428.61,
      scaleSurvivingChangesPerMonth: 30,
    });
    expect(result.assumptions).toEqual({
      engineerMonthlyLoadedUsd: 5000,
      scaleSessionsPerWeek: 7,
    });
  });

  it("returns null cost-per-surviving-change when monthly spend is null or surviving changes are 0", () => {
    const result = buildBook({
      periodDays: 30,
      setups: [
        {
          id: "missing-cost",
          label: "Missing Cost",
          costUsd: null,
          sessions: 5,
          survivingChanges: 2,
          unattendedShare: 0.1,
        },
        {
          id: "zero-changes",
          label: "Zero Changes",
          costUsd: 100,
          sessions: 5,
          survivingChanges: 0,
          unattendedShare: 0.2,
        },
      ],
      promoted: null,
      assumptions: {
        engineerMonthlyLoadedUsd: 5000,
        scaleSessionsPerWeek: 7,
      },
    });

    expect(result.department).toEqual([
      {
        setup: "missing-cost",
        label: "Missing Cost",
        monthlySpendUsd: null,
        survivingChangesPerMonth: 2,
        costPerSurvivingChangeUsd: null,
        unattendedPct: 10.0,
      },
      {
        setup: "zero-changes",
        label: "Zero Changes",
        monthlySpendUsd: 100,
        survivingChangesPerMonth: 0,
        costPerSurvivingChangeUsd: null,
        unattendedPct: 20.0,
      },
    ]);
    expect(result.scenario).toEqual({
      hireMonthlyUsd: 5000,
      scaleMonthlyUsd: null,
      scaleSurvivingChangesPerMonth: null,
    });
    expect(result.assumptions).toEqual({
      engineerMonthlyLoadedUsd: 5000,
      scaleSessionsPerWeek: 7,
    });
  });
});
