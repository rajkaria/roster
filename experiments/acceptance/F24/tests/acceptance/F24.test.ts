import { describe, test, expect } from "bun:test";
import { BudgetGuard, BudgetExceeded } from "../../src/harness/budget.ts";

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
});
