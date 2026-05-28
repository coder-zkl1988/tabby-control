/**
 * Parses SKILL.md (YAML frontmatter + Markdown body) into structured AppSkill data.
 * Mirrors TabbyApp SkillParser.kt parsing logic in idiomatic TypeScript.
 *
 * @module skill-parser
 */

import type {
  AppSkill,
  RiskSignal,
  GlobalHandler,
  IntentRoute,
  Operation,
  OpParam,
  SkillStep,
  FailureRule,
} from './skill-types.js';

// ---------------------------------------------------------------------------
// Frontmatter
// ---------------------------------------------------------------------------

/**
 * Split YAML frontmatter from markdown body.
 * Returns [frontmatter map, body string].
 */
function splitFrontmatter(markdown: string): [Record<string, string>, string] {
  const trimmed = markdown.trimStart();
  if (!trimmed.startsWith('---')) return [{}, markdown];

  const endIdx = trimmed.indexOf('---', 3);
  if (endIdx < 0) return [{}, markdown];

  const frontStr = trimmed.substring(3, endIdx).trim();
  const body = trimmed.substring(endIdx + 3).trim();

  const metadata: Record<string, string> = {};
  for (const line of frontStr.split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx > 0) {
      const key = line.substring(0, colonIdx).trim();
      const value = line.substring(colonIdx + 1).trim();
      metadata[key] = value;
    }
  }
  return [metadata, body];
}

// ---------------------------------------------------------------------------
// Table sections
// ---------------------------------------------------------------------------

/**
 * Parse table rows from a markdown section under a `## heading`.
 * Returns all rows (including the header row). Separator lines are skipped.
 */
function parseTableSection(body: string, heading: string): string[][] {
  const lines = body.split('\n');
  const result: string[][] = [];
  let inSection = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.startsWith('## ')) {
      inSection = trimmed.replace(/^##\s+/, '').trim().startsWith(heading);
      continue;
    }

    // Stop at the next ## heading
    if (inSection && trimmed.startsWith('## ')) break;
    if (!inSection) continue;

    // Skip separator lines like |---|---|
    const stripped = trimmed.replace(/\|/g, '').replace(/-/g, '').replace(/ /g, '');
    if (trimmed.startsWith('|') && stripped === '') continue;

    if (trimmed.startsWith('|')) {
      const cells = trimmed
        .split('|')
        .map((c) => c.trim())
        .filter((c) => c.length > 0);
      if (cells.length > 0) result.push(cells);
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Section parsers
// ---------------------------------------------------------------------------

function parseRiskSignals(body: string): RiskSignal[] {
  const rows = parseTableSection(body, '风险信号');
  // Drop header row
  return rows.slice(1).map((row) => ({
    signal: row[0] ?? '',
    action: row[1] ?? '',
  }));
}

function parseGlobalHandlers(body: string): GlobalHandler[] {
  const rows = parseTableSection(body, '全局弹窗处理');
  // Drop header row
  return rows.slice(1).map((row) => {
    return {
      popup: row[0] ?? '',
      identification: row[1] ?? '',
      action: row[2] ?? '',
    };
  });
}

function parseIntentRouting(body: string): IntentRoute[] {
  const rows = parseTableSection(body, '意图路由');
  // Drop header row
  return rows.slice(1).map((row) => ({
    intent: row[0] ?? '',
    operation: row[1] ?? '',
    keywords: (row[2] ?? '')
      .split('、')
      .map((k) => k.trim())
      .filter((k) => k.length > 0),
  }));
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

function parseOperations(body: string): Map<string, Operation> {
  const operations = new Map<string, Operation>();
  const lines = body.split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i].trim();
    if (line.startsWith('### ')) {
      const opName = line.replace(/^###\s+/, '').trim();
      const opLines: string[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const next = lines[j].trim();
        if (next.startsWith('### ') || next.startsWith('## ')) break;
        opLines.push(lines[j]);
        j++;
      }
      operations.set(opName, parseOperation(opName, opLines));
      i = j;
    } else {
      i++;
    }
  }

  return operations;
}

function parseOperation(name: string, lines: string[]): Operation {
  let requiresConfirmation = false;
  const params: OpParam[] = [];
  const steps: SkillStep[] = [];
  const failureHandling: FailureRule[] = [];

  const paramRegex = /\*\*参数\*\*:\s*(.+)/;
  const confirmRegex = /\*\*需要确认\*\*:\s*(true|false)/;
  const stepRegex = /\*\*Step \d+:\s*(.+)\*\*/;
  const typeRegex = /-\s*类型[：:]\s*(deterministic|flexible)/;
  const actionRegex = /-\s*动作[：:]\s*(.+)/;
  const promptRegex = /-\s*提示[：:]\s*(.+)/;
  const maxStepsRegex = /-\s*maxSteps[：:]\s*(\d+)/;
  const validationRegex = /-\s*验证[：:]\s*(.+)/;

  let currentStep: SkillStep | null = null;

  function flushStep(): void {
    if (currentStep != null) {
      steps.push(currentStep);
      currentStep = null;
    }
  }

  for (const line of lines) {
    const trimmed = line.trim();

    // -- Parameters (single line) --
    const paramMatch = paramRegex.exec(trimmed);
    if (paramMatch) {
      const paramStr = paramMatch[1];
      const paramParts = paramStr.split(',').map((p) => p.trim());
      for (const part of paramParts) {
        const pRegex = /(\w+)\s*\((\w+(?:\[\])?)\s*,\s*(必需|可选)(?:\s*,\s*(.+))?\)/;
        const pMatch = pRegex.exec(part);
        if (pMatch) {
          params.push({
            name: pMatch[1],
            type: pMatch[2],
            required: pMatch[3] === '必需',
            description: pMatch[4]?.trim() ?? '',
          });
        }
      }
    }

    // -- Requires confirmation --
    const confirmMatch = confirmRegex.exec(trimmed);
    if (confirmMatch) {
      requiresConfirmation = confirmMatch[1] === 'true';
    }

    // -- Step header --
    const stepMatch = stepRegex.exec(trimmed);
    if (stepMatch) {
      flushStep();
      currentStep = { name: stepMatch[1], type: 'deterministic' };
    }

    // -- Step properties --
    if (currentStep != null) {
      const typeMatch = typeRegex.exec(trimmed);
      if (typeMatch) {
        currentStep = {
          ...currentStep,
          type: typeMatch[1] === 'flexible' ? 'flexible' : 'deterministic',
        };
      }

      const actionMatch = actionRegex.exec(trimmed);
      if (actionMatch) {
        currentStep = { ...currentStep, action: actionMatch[1].trim() };
      }

      const promptMatch = promptRegex.exec(trimmed);
      if (promptMatch) {
        currentStep = { ...currentStep, prompt: promptMatch[1].trim() };
      }

      const maxStepsMatch = maxStepsRegex.exec(trimmed);
      if (maxStepsMatch) {
        currentStep = {
          ...currentStep,
          maxSteps: parseInt(maxStepsMatch[1], 10),
        };
      }

      const validationMatch = validationRegex.exec(trimmed);
      if (validationMatch) {
        currentStep = { ...currentStep, validation: validationMatch[1].trim() };
      }
    }
  }
  flushStep();

  // -- Failure handling table --
  let inFailureTable = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('**失败处理**') || trimmed.startsWith('**失败处理**:')) {
      inFailureTable = true;
      continue;
    }

    if (inFailureTable && trimmed.startsWith('|')) {
      const stripped = trimmed.replace(/\|/g, '').replace(/-/g, '').replace(/ /g, '');
      if (stripped === '') continue;

      const cells = trimmed
        .split('|')
        .map((c) => c.trim())
        .filter((c) => c.length > 0);
      if (cells.length >= 2) {
        failureHandling.push({ scenario: cells[0], action: cells[1] });
      }
    } else if (inFailureTable && !trimmed.startsWith('|')) {
      inFailureTable = false;
    }
  }

  return {
    name,
    params,
    steps,
    failureHandling,
    requiresConfirmation,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse a full SKILL.md document into a structured {@link AppSkill} object.
 *
 * @param markdown - Raw markdown content of a SKILL.md file
 * @returns Parsed skill, or `null` if parsing fails
 */
export function parseSkill(markdown: string): AppSkill | null {
  try {
    const [frontmatter, body] = splitFrontmatter(markdown);
    const riskSignals = parseRiskSignals(body);
    const globalHandlers = parseGlobalHandlers(body);
    const intentRouting = parseIntentRouting(body);
    const operations = parseOperations(body);

    return {
      name: frontmatter['name'] ?? '',
      app: frontmatter['app'] ?? '',
      version: frontmatter['version'] ?? '1.0.0',
      description: frontmatter['description'] ?? '',
      riskSignals,
      globalHandlers,
      intentRouting,
      operations,
    };
  } catch (e) {
    console.error('Failed to parse SKILL.md:', e);
    return null;
  }
}
