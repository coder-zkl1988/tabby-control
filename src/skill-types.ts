/**
 * Desktop-side skill data types.
 * Mirrors TabbyApp SkillModels.kt for parsing SKILL.md files.
 */

export interface StrategyChain {
  accessibilitySelector?: string;
  visualPrompt?: string;
}

export interface RiskSignal {
  signal: string;
  action: string;
}

export interface GlobalHandler {
  popup: string;
  identification: string;
  strategy: string;
  strategyChain?: StrategyChain;
}

export interface IntentRoute {
  intent: string;
  operation: string;
  keywords: string[];
}

export interface OpParam {
  name: string;
  type: string;
  required: boolean;
  description?: string;
}

export type StepType = 'deterministic' | 'flexible';

export interface SkillStep {
  name: string;
  type: StepType;
  strategy?: StrategyChain;
  action?: string;
  prompt?: string;
  maxSteps?: number;
  validation?: string;
}

export interface FailureRule {
  scenario: string;
  action: string;
}

export interface Operation {
  name: string;
  params: OpParam[];
  steps: SkillStep[];
  failureHandling: FailureRule[];
  requiresConfirmation: boolean;
}

export interface AppSkill {
  name: string;
  app: string;
  version: string;
  description: string;
  riskSignals: RiskSignal[];
  globalHandlers: GlobalHandler[];
  intentRouting: IntentRoute[];
  operations: Map<string, Operation>;
}
