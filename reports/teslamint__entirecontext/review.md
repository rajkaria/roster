# Review: teslamint/entirecontext

- Review id: `teslamint__entirecontext-20261010202502`
- Created: 2026-10-10T20:25:02.850Z
- Entire data: yes
- Evidence level: A (observational)
- Label: `insufficient_data`
- Suspect: none

No suspect call. The difficulty-matched Mantel–Haenszel test (DESIGN.md §"Difficulty and review") is not part of this command yet, so the setup numbers below are descriptive only.

## Setups

| Setup | Harness · model | Sessions | Mature | Spend | Survival | Reverted | Rework (human) | Unattended | $/surviving change | Evidence |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | :---: |
| `2c41ee8951f7` | Claude Code · claude-opus-5 (rules 63a5bf) | 3 | 3 | unknown (0/3 priced) | 99.7% | 0.0% | 0.0% | 0.0% | — | A |
| `69b7b330f1ff` | Codex · gpt-6-astra | 1 | 1 | $26.21 | 0.0% | 0.0% | 0.0% | 0.0% | — | A |
| `6fa0cd70b4cb` | Claude Code · claude-opus-4-6 (rules 208dd8) | 10 | 0 | unknown (0/10 priced) | too young | too young | too young | 0.0% | — | A |
| `8cf918f1b11f` | Claude Code · claude-opus-4-6[1m] | 2 | 2 | unknown (0/2 priced) | 0.0% | 0.0% | 0.0% | 0.0% | — | A |
| `941e13030761` | Claude Code · claude-opus-4-6 (rules unknown) | 39 | 39 | unknown (0/39 priced) | 93.8% | 0.0% | 9.3% | 0.0% | — | A |
| `9a5a5b5af09f` | Codex · gpt-5.6-sol (rules unknown) | 9 | 9 | unknown (0/9 priced) | 89.9% | 0.0% | 16.8% | 55.6% | — | A |
| `9c368a7240ab` | Claude Code · claude-opus-5 (rules unknown) | 6 | 6 | unknown (0/6 priced) | 48.7% | 100.0% | 62.3% | 0.0% | — | A |
| `9f69f40d4f3d` | Claude Code · claude-opus-5-5 | 7 | 6 | $2.04 | 99.7% | 0.0% | 0.0% | 0.0% | $0.26 | A |
| `a837690aa52b` | Claude Code · claude-opus-5 (rules 208dd8) | 18 | 6 | unknown (0/18 priced) | 11.9% | 0.0% | 1.7% | 0.0% | — | A |
| `d47c7e9e87ea` | Claude Code · claude-haiku-4-5-20251001 | 1 | 0 | unknown (0/1 priced) | too young | too young | too young | 100.0% | — | A |
| `e00f7ce2ff26` | Codex · gpt-5.6-sol (rules unknown) | 1 | 1 | unknown (0/1 priced) | 97.8% | 0.0% | 0.6% | 0.0% | — | A |

## Notes

- 54 sessions are too young or have no commit: a session is mature at ≥ 5 first-parent commits and ≥ 6 h before HEAD
- 118 sessions have no price (unknown model, or a price that depends on prompt size)
- 30 sessions have no setup because their rules hash is unknown
