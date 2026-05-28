/**
 * Desktop-side skill data types.
 * Mirrors TabbyApp SkillModels.kt for parsing SKILL.md files.
 */

export interface RiskSignal {
  signal: string;
  action: string;
}

export interface GlobalHandler {
  popup: string;
  identification: string;
  action: string;  // natural language e.g. "点击关闭按钮或X图标"
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
  action?: string;     // natural language description for deterministic steps
  prompt?: string;     // prompt guiding VLM for flexible steps
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
