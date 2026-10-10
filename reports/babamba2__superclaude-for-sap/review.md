# Review: babamba2/superclaude-for-sap

- Review id: `babamba2__superclaude-for-sap-20261010215757`
- Created: 2026-10-10T21:57:57.808Z
- Entire data: yes
- Evidence level: A (observational)
- Label: `insufficient_data`
- Suspect: none

No suspect call. The difficulty-matched Mantel–Haenszel test (DESIGN.md §"Difficulty and review") is not part of this command yet, so the setup numbers below are descriptive only.

## Setups

| Setup | Harness · model | Sessions | Mature | Spend | Survival | Reverted | Rework (human) | Unattended | $/surviving change | Evidence |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | :---: |
| `3a5df6d57f00` | Claude Code · claude-opus-5-5 (rules unknown) | 1 | 1 | $1.82 | 97.4% | 0.0% | 4.1% | 100.0% | $1.87 | A |
| `4962478318ca` | Claude Code · claude-opus-4-7[1m] | 1 | 1 | unknown (0/1 priced) | 85.0% | 0.0% | 8.9% | 0.0% | — | A |
| `4f20676e66f9` | Claude Code · claude-opus-5-5 (rules c2b135) | 4 | 4 | $56.31 | 97.1% | 0.0% | 1.0% | 100.0% | $14.50 | A |
| `713ed3781fc7` | Claude Code · claude-opus-4-7 (rules unknown) | 6 | 5 | unknown (0/6 priced) | 69.7% | 0.0% | 5.8% | 66.7% | — | A |
| `a381cc570203` | Claude Code · claude-opus-4-7 (rules unknown) | 2 | 2 | unknown (0/2 priced) | 51.1% | 0.0% | 14.3% | 50.0% | — | A |
| `b84cde69171a` | Claude Code · claude-opus-4-8[1m] | 1 | 1 | unknown (0/1 priced) | 95.9% | 0.0% | 3.1% | 0.0% | — | A |
| `c4595f0cb476` | Claude Code · claude-fable-5 | 1 | 1 | unknown (0/1 priced) | 98.1% | 0.0% | 2.4% | 0.0% | — | A |
| `dc969432d1ac` | Claude Code · claude-sonnet-4-6 | 1 | 1 | unknown (0/1 priced) | 94.7% | 0.0% | 3.9% | 0.0% | — | A |
| `dd8dca5d364d` | Claude Code · claude-opus-5-5 (rules 416805) | 4 | 3 | $43.25 | 88.8% | 0.0% | 0.0% | 100.0% | $13.43 | A |

## Notes

- 6 sessions are too young or have no commit: a session is mature at ≥ 5 first-parent commits and ≥ 6 h before HEAD
- 16 sessions have no price (unknown model, or a price that depends on prompt size)
- 4 sessions have no setup because their rules hash is unknown
