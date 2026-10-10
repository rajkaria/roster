# Roster

> An agent that runs performance reviews for your AI coding agents.

**Status:** being built during [neatHack](https://neatlogs.com/hackathon), Oct 10–12 2026. Nothing here is claimed to work until it shows up in [`docs/FACTS.md`](docs/FACTS.md), which is generated from real runs.

## What it will do
Roster takes a repo whose coding-agent sessions are recorded with Entire, and then:
1. It scores every session: cost, whether the change survived, whether it was reverted or reworked.
2. It names the setup it suspects is weakest, comparing tasks of similar difficulty.
3. It tests that suspicion. It replays the suspect's real past tasks under candidate setups, each at the commit before it, with no access to later history.
4. It promotes a candidate only if nothing regresses, and opens a pull request with the change.
5. It books the result into the team's cfo.ai plan.

[`docs/DESIGN.md`](docs/DESIGN.md) is the engineering contract.

**This repo is also the experiment.** Four agent setups are building it ([`setups/`](setups)), and Roster will review them. [`experiments/PREREGISTRATION.md`](experiments/PREREGISTRATION.md) fixes the test before any result exists.

## Built with
[Entire](https://entire.io) · [neatlogs](https://neatlogs.com) · [cfo.ai](https://cfo.ai)

## License
MIT
