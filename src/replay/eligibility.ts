export type ReplayTrack = 'tests' | 'judge-only' | 'none';

export interface EligibilityResult {
  eligible: boolean;
  track: ReplayTrack;
  reason: string;
}

const none = (reason: string): EligibilityResult => ({ eligible: false, track: 'none', reason });

export async function checkEligibility(
  task: { userPrompts: number; hiddenTests: string[]; strategy: string },
  probe: () => Promise<{ installs: boolean; suitePasses: boolean }>,
): Promise<EligibilityResult> {
  if (task.strategy === 'import') return none('imported history');
  if (task.userPrompts > 2) return none('more than 2 user prompts');
  const p = await probe();
  if (!p.installs) return none('parent does not install');
  if (!p.suitePasses) return none('suite fails at parent');
  if (task.hiddenTests.length === 0) {
    return { eligible: true, track: 'judge-only', reason: 'no hidden tests; judge-only track' };
  }
  return { eligible: true, track: 'tests', reason: 'eligible with hidden tests' };
}
