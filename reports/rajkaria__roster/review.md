# Review: rajkaria/roster

- Review id: `rajkaria__roster-20261011034742`
- Created: 2026-10-11T03:47:42.785Z
- Entire data: yes
- Evidence level: A (observational)
- Label: `no_suspect`
- Suspect: none

No setup is flagged: no setup with ≥ 8 mature sessions has a difficulty-matched odds ratio above 1 at p < 0.05. The highest matched odds ratio is shown for context only.

## Setups

| Setup | Harness · model | Sessions | Mature | Spend | Survival | Reverted | Rework (human) | Unattended | $/surviving change | Evidence |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | :---: |
| `6a200cd990a7` | Claude Code · claude-opus-5-5 | 17 | 16 | $19.06 | 98.9% | 0.0% | 1.2% | 100.0% | $1.17 | A |
| `97433f7b4446` | Claude Code · claude-sonnet-5-5 (rules 243fa2) | 11 | 10 | $3.84 | 97.7% | 0.0% | 0.3% | 63.6% | $0.35 | A |
| `a9544a002085` | Claude Code · claude-sonnet-5-5 (rules dabdd0) | 17 | 17 | $4.28 | 98.8% | 0.0% | 0.1% | 100.0% | $0.25 | A |
| `c8d6907735ec` | Claude Code · claude-haiku-5-5 | 16 | 14 | ≥ $1.42 | 97.6% | 0.0% | 1.2% | 62.5% | $0.09 | A |

## Prompt tags

Tag accuracy: 91.7%

| Tag | Sessions | Inferred setups |
| --- | ---: | --- |
| `A` | 17 | `6a200cd990a7` |
| `B` | 12 | `a9544a002085` |
| `C` | 16 | `c8d6907735ec` |
| `D` | 15 | `97433f7b4446`, `a9544a002085` |

## Notes

- 4 sessions are too young or have no commit: a session is mature at ≥ 5 first-parent commits and ≥ 6 h before HEAD
- 0 sessions have no price (unknown model, or a price that depends on prompt size)
- 0 sessions have no setup because their rules hash is unknown
- suspect call: no setup with ≥ 8 mature sessions has a difficulty-matched odds ratio above 1 at p < 0.05
