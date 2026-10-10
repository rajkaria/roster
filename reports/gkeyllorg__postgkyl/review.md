# Review: gkeyllorg/postgkyl

- Review id: `gkeyllorg__postgkyl-20261010190853`
- Created: 2026-10-10T19:08:53.659Z
- Entire data: yes
- Evidence level: A (observational)
- Label: `insufficient_data`
- Suspect: none

No suspect call. The difficulty-matched Mantel–Haenszel test (DESIGN.md §"Difficulty and review") is not part of this command yet, so the setup numbers below are descriptive only.

## Setups

| Setup | Harness · model | Sessions | Mature | Spend | Survival | Reverted | Rework (human) | Unattended | $/surviving change | Evidence |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | :---: |
| `085dfcb5897f` | Codex · gpt-5.6-sol (rules unknown) | 1 | 1 | unknown (0/1 priced) | 74.8% | 0.0% | 3.9% | 0.0% | — | A |
| `0f7c611d4469` | Codex · gpt-6-astra (rules unknown) | 48 | 48 | $238.93 | 83.9% | 0.0% | 2.4% | 52.1% | $5.93 | A |
| `28691ca7e13a` | Codex · gpt-5.6-sol (rules unknown) | 1 | 1 | unknown (0/1 priced) | 79.2% | 0.0% | 0.1% | 0.0% | — | A |
| `4fc5048b9f4b` | Codex · gpt-5.6-sol (rules unknown) | 3 | 3 | unknown (0/3 priced) | 75.1% | 0.0% | 5.6% | 0.0% | — | A |
| `6567d112bcac` | Codex · gpt-6-astra (rules unknown) | 3 | 3 | $68.70 | 65.6% | 0.0% | 0.2% | 0.0% | $34.89 | A |
| `749fbe9c72b9` | Codex · gpt-6-astra (rules unknown) | 2 | 2 | $14.56 | 47.9% | 0.0% | 9.7% | 0.0% | $15.19 | A |
| `880e8b2d28af` | Codex · gpt-6-astra (rules unknown) | 11 | 11 | $52.61 | 82.5% | 0.0% | 0.3% | 27.3% | $5.80 | A |
| `a424ac4c98e0` | Codex · gpt-6-astra (rules unknown) | 6 | 6 | $52.37 | 30.6% | 0.0% | 0.0% | 0.0% | $28.55 | A |
| `c4da1686a163` | Codex · gpt-5.6-sol (rules unknown) | 3 | 3 | unknown (0/3 priced) | 89.7% | 0.0% | 0.9% | 0.0% | — | A |

## Notes

- 76 sessions are too young or have no commit: a session is mature at ≥ 5 first-parent commits and ≥ 6 h before HEAD
- 79 sessions have no price (unknown model, or a price that depends on prompt size)
- 76 sessions have no setup because their rules hash is unknown
