# Review: rajkaria/roster

- Review id: `rajkaria__roster-20261010222100`
- Created: 2026-10-10T22:21:00.519Z
- Entire data: yes
- Evidence level: A (observational)
- Label: `insufficient_data`
- Suspect: none

No suspect call. The difficulty-matched Mantel–Haenszel test (DESIGN.md §"Difficulty and review") is not part of this command yet, so the setup numbers below are descriptive only.

## Setups

| Setup | Harness · model | Sessions | Mature | Spend | Survival | Reverted | Rework (human) | Unattended | $/surviving change | Evidence |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | :---: |
| `6a200cd990a7` | Claude Code · claude-opus-5-5 | 16 | 9 | $18.48 | 99.5% | 0.0% | 0.2% | 100.0% | $1.00 | A |
| `97433f7b4446` | Claude Code · claude-sonnet-5-5 (rules 243fa2) | 10 | 2 | $3.41 | 100.0% | 0.0% | 0.0% | 60.0% | $0.20 | A |
| `a9544a002085` | Claude Code · claude-sonnet-5-5 (rules dabdd0) | 17 | 12 | $4.28 | 99.4% | 0.0% | 0.0% | 100.0% | $0.26 | A |
| `c8d6907735ec` | Claude Code · claude-haiku-5-5 | 14 | 9 | ≥ $1.22 | 99.9% | 0.0% | 0.1% | 64.3% | $0.07 | A |

## Prompt tags

Tag accuracy: 91.1%

| Tag | Sessions | Inferred setups |
| --- | ---: | --- |
| `A` | 16 | `6a200cd990a7` |
| `B` | 12 | `a9544a002085` |
| `C` | 14 | `c8d6907735ec` |
| `D` | 14 | `97433f7b4446`, `a9544a002085` |

## Notes

- 25 sessions are too young or have no commit: a session is mature at ≥ 5 first-parent commits and ≥ 6 h before HEAD
- 0 sessions have no price (unknown model, or a price that depends on prompt size)
- 0 sessions have no setup because their rules hash is unknown
