# Review: rajkaria/roster

- Review id: `rajkaria__roster-20261010151047`
- Created: 2026-10-10T15:10:47.728Z
- Entire data: yes
- Evidence level: A (observational)
- Label: `insufficient_data`
- Suspect: none

No suspect call. The difficulty-matched Mantel–Haenszel test (DESIGN.md §"Difficulty and review") is not part of this command yet, so the setup numbers below are descriptive only.

## Setups

| Setup | Harness · model | Sessions | Mature | Spend | Survival | Reverted | Rework (human) | Unattended | $/surviving change | Evidence |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | :---: |
| `6a200cd990a7` | Claude Code · claude-opus-5-5 | 8 | 0 | $8.76 | too young | too young | too young | too young | — | A |
| `a9544a002085` | Claude Code · claude-sonnet-5-5 | 10 | 0 | $2.40 | too young | too young | too young | too young | — | A |
| `c8d6907735ec` | Claude Code · claude-haiku-5-5 | 5 | 0 | $0.00 | too young | too young | too young | too young | — | A |

## Prompt tags

Tag accuracy: 56.5%

| Tag | Sessions | Inferred setups |
| --- | ---: | --- |
| `A` | 8 | `6a200cd990a7` |
| `B` | 5 | `a9544a002085` |
| `C` | 5 | `c8d6907735ec` |
| `D` | 5 | `a9544a002085` |

## Notes

- 23 sessions are too young or have no commit: a session is mature at ≥ 5 first-parent commits and ≥ 6 h before HEAD
- 5 sessions have no price (unknown model, or a price that depends on prompt size)
- 0 sessions have no setup because their rules hash is unknown
