// Hard spend caps per run and per task (DESIGN.md §"Plan (coordinator)", §"Gate").
//
// A run's `budget_usd` is shared by everything it does: LLM turns and replays together. A caller
// reserves before starting a piece of work that will spend:
//
//   const reservation = guard.reserve(taskId, estimateUsd); // throws BudgetExceeded when a cap would be crossed
//
// then calls `reservation.commit(actualUsd)` with what it really spent, or `reservation.release()`
// when it spent nothing. An open reservation holds its amount, so a second caller cannot reserve the
// same dollars.
//
// Concurrency: reserve() is synchronous, so the check and the bookkeeping that follows it cannot be
// interleaved with another caller on the same guard. Two callers racing for the last dollars cannot both
// win — the loser throws BudgetExceeded.

/** Raised by `reserve` when the run cap or the task cap would be crossed. */
export class BudgetExceeded extends Error {
  /** Which cap would have been crossed. */
  readonly cap: "run" | "task";
  /** The amount `reserve` was asked for. */
  readonly requestedUsd: number;

  constructor(cap: "run" | "task", requestedUsd: number, message: string) {
    super(message);
    this.name = "BudgetExceeded";
    this.cap = cap;
    this.requestedUsd = requestedUsd;
  }
}

/** A hold on an amount that is not spent yet. Exactly one of `commit` or `release` ends it. */
export interface Reservation {
  /** Replace the hold with the amount actually spent. The actual may exceed the hold; it still counts. */
  commit(actualUsd: number): void;
  /** Give the hold back unspent. */
  release(): void;
}

function checkAmount(usd: number, what: string): void {
  if (!Number.isFinite(usd) || usd < 0) throw new RangeError(`${what} must be a finite non-negative number, got ${usd}`);
}

/**
 * Tracks a run's spend against a run cap and a per-task cap. `used()` counts only what has been
 * committed; an open reservation still holds its amount against `remaining()` and against the caps.
 */
export class BudgetGuard {
  readonly runCapUsd: number;
  readonly taskCapUsd: number;

  /** Committed spend, whole run. */
  #used = 0;
  /** Sum of the holds that are still open. */
  #reserved = 0;
  /** Committed spend per task. */
  #taskUsed = new Map<string, number>();
  /** Sum of the holds that are still open, per task. */
  #taskReserved = new Map<string, number>();

  constructor(runCapUsd: number, taskCapUsd: number) {
    checkAmount(runCapUsd, "runCapUsd");
    checkAmount(taskCapUsd, "taskCapUsd");
    this.runCapUsd = runCapUsd;
    this.taskCapUsd = taskCapUsd;
  }

  /**
   * Hold `usd` for `task`. Throws BudgetExceeded when the hold would push the run past its cap, or the
   * task past its cap. Nothing is recorded when it throws.
   */
  reserve(task: string, usd: number): Reservation {
    checkAmount(usd, "reserve amount");
    const runTotal = this.#used + this.#reserved + usd;
    if (runTotal > this.runCapUsd) {
      throw new BudgetExceeded(
        "run",
        usd,
        `run budget exceeded: $${this.#used.toFixed(4)} used + $${this.#reserved.toFixed(4)} reserved + $${usd.toFixed(4)} requested > $${this.runCapUsd.toFixed(4)} cap`,
      );
    }
    const taskTotal = (this.#taskUsed.get(task) ?? 0) + (this.#taskReserved.get(task) ?? 0);
    if (taskTotal + usd > this.taskCapUsd) {
      throw new BudgetExceeded(
        "task",
        usd,
        `task ${task} budget exceeded: $${taskTotal.toFixed(4)} against the task + $${usd.toFixed(4)} requested > $${this.taskCapUsd.toFixed(4)} cap`,
      );
    }

    this.#reserved += usd;
    this.#taskReserved.set(task, (this.#taskReserved.get(task) ?? 0) + usd);

    let state: "open" | "committed" | "released" = "open";
    const end = (kind: "committed" | "released"): void => {
      if (state !== "open") throw new Error(`reservation for ${task} was already ${state}`);
      state = kind;
    };

    return {
      commit: (actualUsd: number): void => {
        checkAmount(actualUsd, "commit amount");
        end("committed");
        this.#reserved -= usd;
        this.#used += actualUsd;
        this.#taskReserved.set(task, (this.#taskReserved.get(task) ?? 0) - usd);
        this.#taskUsed.set(task, (this.#taskUsed.get(task) ?? 0) + actualUsd);
      },
      release: (): void => {
        end("released");
        this.#reserved -= usd;
        this.#taskReserved.set(task, (this.#taskReserved.get(task) ?? 0) - usd);
      },
    };
  }

  /** Amount committed so far. Open reservations are not counted here. */
  used(): number {
    return this.#used;
  }

  /** Run cap minus committed spend minus open reservations. Over-spend (a commit above the cap) makes it negative. */
  remaining(): number {
    return this.runCapUsd - this.#used - this.#reserved;
  }
}
