import { describe, expect, test } from "bun:test";
import { BudgetExceeded, BudgetGuard } from "../src/harness/budget.ts";

describe("BudgetGuard", () => {
  test("reserve throws BudgetExceeded when run cap would be exceeded", () => {
    const guard = new BudgetGuard(10, 100);
    guard.reserve("a", 6);
    expect(() => guard.reserve("b", 5)).toThrow(BudgetExceeded);
  });

  test("reserve throws BudgetExceeded when task cap would be exceeded", () => {
    const guard = new BudgetGuard(100, 10);
    guard.reserve("a", 6);
    expect(() => guard.reserve("a", 5)).toThrow(BudgetExceeded);
  });

  test("commit replaces reservation with actual amount and counts it", () => {
    const guard = new BudgetGuard(10, 20);
    const reservation = guard.reserve("a", 3);

    expect(guard.used()).toBe(0);
    expect(guard.remaining()).toBe(7);

    reservation.commit(7);

    expect(guard.used()).toBe(7);
    expect(guard.remaining()).toBe(3);

    // The reservation was replaced, so only the actual 7 counts against run cap.
    expect(() => guard.reserve("b", 4)).toThrow(BudgetExceeded);
  });

  test("committed actual counts toward task cap", () => {
    const guard = new BudgetGuard(100, 10);
    const reservation = guard.reserve("a", 3);
    reservation.commit(7);

    expect(() => guard.reserve("a", 4)).toThrow(BudgetExceeded);
  });

  test("release frees the reservation", () => {
    const guard = new BudgetGuard(10, 20);
    const reservation = guard.reserve("a", 7);
    reservation.release();

    expect(guard.used()).toBe(0);
    expect(guard.remaining()).toBe(10);
    expect(() => guard.reserve("b", 7)).not.toThrow();
  });

  test("double commit throws", () => {
    const guard = new BudgetGuard(10, 20);
    const reservation = guard.reserve("a", 2);
    reservation.commit(2);

    expect(() => reservation.commit(2)).toThrow();
  });

  test("double release throws", () => {
    const guard = new BudgetGuard(10, 20);
    const reservation = guard.reserve("a", 2);
    reservation.release();

    expect(() => reservation.release()).toThrow();
  });

  test("a failed reserve records nothing", () => {
    const guard = new BudgetGuard(10, 5);
    guard.reserve("a", 3);
    expect(() => guard.reserve("a", 3)).toThrow(BudgetExceeded);

    expect(guard.remaining()).toBe(7);
    // The task cap is untouched by the failed call, so 2 more still fits.
    expect(() => guard.reserve("a", 2)).not.toThrow();
  });

  test("caps are per task and per run independently", () => {
    const guard = new BudgetGuard(10, 4);
    guard.reserve("a", 4);
    // Task a is full at 4; a second task still has the run's remaining 6.
    expect(() => guard.reserve("a", 1)).toThrow(BudgetExceeded);
    expect(() => guard.reserve("b", 4)).not.toThrow();
    expect(guard.remaining()).toBe(2);
  });

  test("commit may exceed the reservation and still counts", () => {
    const guard = new BudgetGuard(10, 20);
    const reservation = guard.reserve("a", 2);
    reservation.commit(9);

    expect(guard.used()).toBe(9);
    expect(guard.remaining()).toBe(1);
    expect(() => guard.reserve("b", 2)).toThrow(BudgetExceeded);
  });

  test("over-spend makes remaining negative rather than clamping", () => {
    const guard = new BudgetGuard(5, 20);
    guard.reserve("a", 4).commit(6);

    expect(guard.used()).toBe(6);
    expect(guard.remaining()).toBe(-1);
    expect(() => guard.reserve("a", 0.01)).toThrow(BudgetExceeded);
  });

  test("commit after release throws and release after commit throws", () => {
    const guard = new BudgetGuard(10, 20);
    const released = guard.reserve("a", 2);
    released.release();
    expect(() => released.commit(2)).toThrow();

    const committed = guard.reserve("b", 2);
    committed.commit(2);
    expect(() => committed.release()).toThrow();
  });

  test("a task at its committed cap cannot reserve again", () => {
    const guard = new BudgetGuard(100, 5);
    guard.reserve("a", 5).commit(5);
    expect(() => guard.reserve("a", 0)).not.toThrow();
    expect(() => guard.reserve("a", 0.01)).toThrow(BudgetExceeded);
  });

  test("BudgetExceeded is an Error carrying the cap and the requested amount", () => {
    const guard = new BudgetGuard(10, 100);
    guard.reserve("a", 6);
    try {
      guard.reserve("b", 5);
      throw new Error("expected reserve to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(BudgetExceeded);
      expect((err as BudgetExceeded).cap).toBe("run");
      expect((err as BudgetExceeded).requestedUsd).toBe(5);
      expect((err as BudgetExceeded).name).toBe("BudgetExceeded");
      expect((err as BudgetExceeded).message).toContain("run budget exceeded");
    }

    const taskGuard = new BudgetGuard(100, 10);
    taskGuard.reserve("a", 6);
    try {
      taskGuard.reserve("a", 5);
      throw new Error("expected reserve to throw");
    } catch (err) {
      expect((err as BudgetExceeded).cap).toBe("task");
    }
  });

  test("non-finite or negative amounts are rejected", () => {
    const guard = new BudgetGuard(10, 20);
    expect(() => guard.reserve("a", -1)).toThrow(RangeError);
    expect(() => guard.reserve("a", Number.NaN)).toThrow(RangeError);
    expect(() => guard.reserve("a", Number.POSITIVE_INFINITY)).toThrow(RangeError);
    const reservation = guard.reserve("a", 1);
    expect(() => reservation.commit(-1)).toThrow(RangeError);
    // A rejected commit leaves the reservation open, so the caller can still settle it correctly.
    reservation.commit(1);
    expect(guard.used()).toBe(1);
  });

  test("concurrent reservations never overshoot the run cap", async () => {
    const guard = new BudgetGuard(10, 100);
    const attempts = Array.from({ length: 20 }, (_, i) =>
      (async () => {
        await Bun.sleep(i % 3);
        const reservation = guard.reserve(`task-${i}`, 1);
        reservation.commit(1);
      })(),
    );
    const settled = await Promise.allSettled(attempts);

    const wins = settled.filter((s) => s.status === "fulfilled").length;
    const losses = settled.filter((s) => s.status === "rejected").length;
    expect(wins).toBe(10);
    expect(losses).toBe(10);
    expect(guard.used()).toBe(10);
    expect(guard.remaining()).toBe(0);
  });

  test("concurrent reservations respect the task cap under a shared run cap", async () => {
    const guard = new BudgetGuard(100, 3);
    const attempts = Array.from({ length: 8 }, () =>
      (async () => {
        await Bun.sleep(Math.random() * 2);
        guard.reserve("shared", 1).commit(1);
      })(),
    );
    await Promise.allSettled(attempts);

    expect(guard.used()).toBe(3);
  });
});
