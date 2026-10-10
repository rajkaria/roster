# Review: amjadsaadeh/doorbell-detector

- Review id: `amjadsaadeh__doorbell-detector-20261010215032`
- Created: 2026-10-10T21:50:32.671Z
- Entire data: yes
- Evidence level: A (observational)
- Label: `insufficient_data`
- Suspect: none

No suspect call. The difficulty-matched Mantel–Haenszel test (DESIGN.md §"Difficulty and review") is not part of this command yet, so the setup numbers below are descriptive only.

## Setups

| Setup | Harness · model | Sessions | Mature | Spend | Survival | Reverted | Rework (human) | Unattended | $/surviving change | Evidence |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | :---: |
| `0a94f5d39e79` | Claude Code · claude-sonnet-5 (rules unknown) | 1 | 1 | unknown (0/1 priced) | 66.7% | 0.0% | 26.7% | 100.0% | — | A |
| `10632be0aded` | Claude Code · claude-fable-5 (rules unknown) | 1 | 1 | unknown (0/1 priced) | 100.0% | 0.0% | 0.0% | 0.0% | — | A |
| `19c226a2c258` | Claude Code · claude-fable-5 (rules unknown) | 1 | 1 | unknown (0/1 priced) | 5.6% | 100.0% | 22.2% | 0.0% | — | A |
| `1f93c98c1ce5` | Claude Code · claude-sonnet-5 (rules unknown) | 1 | 0 | unknown (0/1 priced) | too young | too young | too young | 0.0% | — | A |
| `41ff0af85046` | Claude Code · claude-opus-5 (rules unknown) | 1 | 0 | unknown (0/1 priced) | too young | too young | too young | 0.0% | — | A |
| `7aa62d49da08` | Claude Code · claude-opus-5-5[1m] | 2 | 0 | $9.18 | too young | too young | too young | 0.0% | — | A |
| `7c19005e12c0` | Claude Code · claude-opus-5 (rules unknown) | 1 | 0 | unknown (0/1 priced) | too young | too young | too young | 0.0% | — | A |
| `80354e2b478d` | Claude Code · claude-opus-5-5 | 1 | 0 | $3.64 | too young | too young | too young | 0.0% | — | A |
| `848dfc92ec30` | Claude Code · claude-opus-5 (rules 8322f8) | 1 | 0 | unknown (0/1 priced) | too young | too young | too young | 0.0% | — | A |
| `8554ea49bd31` | Claude Code · claude-opus-5 (rules unknown) | 1 | 0 | unknown (0/1 priced) | too young | too young | too young | 0.0% | — | A |
| `96f18d55ce02` | Claude Code · claude-sonnet-5 (rules unknown) | 1 | 1 | unknown (0/1 priced) | 72.0% | 0.0% | 29.0% | 0.0% | — | A |
| `9d865a645c94` | Claude Code · claude-fable-5 (rules unknown) | 1 | 1 | unknown (0/1 priced) | 0.0% | 0.0% | 0.0% | 0.0% | — | A |
| `b614cb157195` | Claude Code · claude-fable-5 (rules unknown) | 2 | 2 | unknown (0/2 priced) | 0.0% | 0.0% | 0.0% | 0.0% | — | A |
| `bb5600b608e7` | Claude Code · claude-sonnet-5 (rules unknown) | 2 | 2 | unknown (0/2 priced) | 17.7% | 100.0% | 5.7% | 0.0% | — | A |
| `c18baa0b8673` | Claude Code · claude-sonnet-5-5 | 1 | 0 | $0.57 | too young | too young | too young | 0.0% | — | A |
| `c93bb4cc58ac` | Claude Code · claude-fable-5 (rules unknown) | 1 | 0 | unknown (0/1 priced) | too young | too young | too young | 0.0% | — | A |
| `d4f1088012b9` | Claude Code · claude-sonnet-5 (rules unknown) | 1 | 1 | unknown (0/1 priced) | 90.7% | 0.0% | 4.0% | 0.0% | — | A |
| `e249be7dc756` | Claude Code · claude-opus-5 (rules unknown) | 1 | 0 | unknown (0/1 priced) | too young | too young | too young | 0.0% | — | A |
| `f2facb9ad2be` | Claude Code · claude-fable-5 (rules unknown) | 1 | 1 | unknown (0/1 priced) | 100.0% | 0.0% | 0.0% | 0.0% | — | A |

## Notes

- 20 sessions are too young or have no commit: a session is mature at ≥ 5 first-parent commits and ≥ 6 h before HEAD
- 27 sessions have no price (unknown model, or a price that depends on prompt size)
- 9 sessions have no setup because their rules hash is unknown
