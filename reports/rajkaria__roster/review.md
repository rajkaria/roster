# Review: rajkaria/roster

- Review id: `rajkaria__roster-20261012015931`
- Created: 2026-10-12T01:59:31.458Z
- Entire data: yes
- Evidence level: A (observational)
- Label: `no_suspect`
- Suspect: none

No setup is flagged: no setup with ≥ 8 mature sessions has a difficulty-matched odds ratio above 1 at p < 0.05. The highest matched odds ratio is shown for context only.

## Setups

| Setup | Harness · model | Sessions | Mature | Spend | Survival | Reverted | Rework (human) | Unattended | $/surviving change | Evidence |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | :---: |
| `6a200cd990a7` | Claude Code · claude-opus-5-5 | 21 | 18 | $23.54 | 98.1% | 0.0% | 1.9% | 100.0% | $1.20 | A |
| `97433f7b4446` | Claude Code · claude-sonnet-5-5 (rules 243fa2) | 15 | 12 | $6.37 | 95.4% | 0.0% | 1.0% | 53.3% | $0.49 | A |
| `a9544a002085` | Claude Code · claude-sonnet-5-5 (rules dabdd0) | 60 | 44 | $10.79 | 67.3% | 0.0% | 0.2% | 58.3% | $0.29 | A |
| `c8d6907735ec` | Claude Code · claude-haiku-5-5 | 18 | 18 | ≥ $2.07 | 97.8% | 0.0% | 0.9% | 55.6% | $0.12 | A |
| `f656e13e2af0` | Claude Code · deepseek-flash | 40 | 22 | $1.26 | 63.6% | 0.0% | 0.0% | 62.5% | $0.06 | A |

## Prompt tags

Tag accuracy: 96.1%

| Tag | Sessions | Inferred setups |
| --- | ---: | --- |
| `A` | 21 | `6a200cd990a7` |
| `B` | 56 | `a9544a002085` |
| `C` | 18 | `c8d6907735ec` |
| `D` | 19 | `97433f7b4446`, `a9544a002085` |
| `E` | 40 | `f656e13e2af0` |

## Notes

- 41 sessions are too young or have no commit: a session is mature at ≥ 5 first-parent commits and ≥ 6 h before HEAD
- 0 sessions have no price (unknown model, or a price that depends on prompt size)
- 1 sessions have no setup because their rules hash is unknown
- suspect call: no setup with ≥ 8 mature sessions has a difficulty-matched odds ratio above 1 at p < 0.05
