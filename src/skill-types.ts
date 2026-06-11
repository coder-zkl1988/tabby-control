/**
 * Skill data types for LLM-provided steps and interrupt handlers.
 *
 * Note: the old desktop-side AppSkill model (operations / intentRouting /
 * riskSignals) was removed — per-app skills now live on the phone
 * (TabbyApp AppSkillRegistry: skill.json + instructions.md + subskills)
 * and are synced over the WebSocket skill channel. The desktop only keeps
 * the step/handler types the orchestrator receives from the LLM.
 */

/** Interrupt handler — strategies for handling interruptions during execution */
export interface Handler {
  name: string;       // e.g. "广告弹窗"
  trigger: string;    // natural language detection cue
  strategy: 'dismiss' | 'ignore' | 'report';
  action?: string;    // natural language action (required when strategy = 'dismiss')
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
