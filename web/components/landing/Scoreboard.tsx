// The hero's split-flap scoreboard: the pre-registered forward test's final numbers, read from forward.json and
// forward-cost.json. Without a published result it says the run is in progress and shows no numbers.
import { FORWARD_SETUPS, usd3, type CostSummary } from "@/lib/landing";
import type { ForwardResult } from "@/lib/result";
import { SplitFlap } from "./SplitFlap";

/** Right-aligns a row's two values to one width, so their tiles line up like a real board. */
const pair = (a: string, b: string): [string, string] => {
  const w = Math.max(a.length, b.length);
  return [a.padStart(w), b.padStart(w)];
};

/** "p = 0.006" becomes "0.006" and "p < 0.001" becomes "<0.001": the board's label already says p. */
const pTile = (p: number): string => (p < 0.001 ? "<0.001" : p.toFixed(3));

export function Scoreboard({ forward, cost }: { forward: ForwardResult | null; cost: CostSummary | null }) {
  if (!forward) {
    return (
      <div className="board" data-glow>
        <div className="board-head">
          <span className="led led-wait" /> Forward test
        </div>
        <p className="board-empty">forward run in progress</p>
      </div>
    );
  }
  const [aloneNew, aloneOld] = pair(String(forward.newOnly), String(forward.oldOnly));
  const costs = cost ? pair(usd3(cost.medianNew), usd3(cost.medianOld)) : null;
  return (
    <div className="board" data-glow>
      <div className="board-head">
        <span className="led" />
        <span>Forward test</span>
        <span className="board-tag">pre-registered · final</span>
      </div>
      <div className="board-grid">
        <span />
        <span className="board-col is-new">
          <b>{FORWARD_SETUPS.new.id}</b> {FORWARD_SETUPS.new.name}
        </span>
        <span className="board-col is-old">
          <b>{FORWARD_SETUPS.old.id}</b> {FORWARD_SETUPS.old.name}
        </span>

        <span className="board-k">Only this one passed</span>
        <span className="board-v is-new">
          <SplitFlap text={aloneNew} start={250} label={`${forward.newOnly} tasks only ${FORWARD_SETUPS.new.full} passed`} />
        </span>
        <span className="board-v is-old">
          <SplitFlap text={aloneOld} start={400} label={`${forward.oldOnly} tasks only ${FORWARD_SETUPS.old.full} passed`} />
        </span>

        {costs && cost && (
          <>
            <span className="board-k">Median cost per task</span>
            <span className="board-v is-new">
              <SplitFlap text={costs[0]} start={550} label={`median ${usd3(cost.medianNew)} per task`} />
            </span>
            <span className="board-v is-old">
              <SplitFlap text={costs[1]} start={700} label={`median ${usd3(cost.medianOld)} per task`} />
            </span>
          </>
        )}
      </div>
      <div className="board-foot">
        <div>
          <span className="board-k">McNemar exact p</span>
          <span className="board-v">
            <SplitFlap text={pTile(forward.p)} start={850} label={`p = ${pTile(forward.p)}`} />
          </span>
        </div>
        {cost && (
          <div>
            <span className="board-k">Cheaper, pair by pair</span>
            <span className="board-v is-new">
              <SplitFlap text={`${cost.cheaperNew}/${cost.pairs}`} start={1000} label={`cheaper in ${cost.cheaperNew} of ${cost.pairs} pairs`} />
            </span>
          </div>
        )}
      </div>
      <p className="board-note">
        {forward.n} valid pairs, each task built once by each setup and graded against the frozen acceptance tests.
      </p>
    </div>
  );
}
