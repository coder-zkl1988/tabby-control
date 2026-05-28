/**
 * Skill data types for LLM-provided steps and interrupt handlers.
 */

export interface RiskSignal {
  signal: string;
  action: string;
}

/** Interrupt handler — strategies for handling interruptions during execution */
export interface Handler {
  name: string;       // e.g. "广告弹窗"
  trigger: string;    // natural language detection cue
  strategy: 'dismiss' | 'ignore' | 'report';
  action?: string;    // natural language action (required when strategy = 'dismiss')
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
  handlers: Handler[];
  intentRouting: IntentRoute[];
  operations: Map<string, Operation>;
}
