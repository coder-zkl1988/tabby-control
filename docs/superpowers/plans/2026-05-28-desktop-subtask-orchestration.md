# Desktop Sub-task Orchestration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement desktop-side (tabby-control) orchestration that decomposes user tasks via SKILL.md, dispatches sub-tasks to phones via `subtask.execute`, and dynamically adjusts based on results — matching spec §6.

**Architecture:** Desktop reads the same SKILL.md format (shared with phone), uses intentRouting to map user tasks to operations, splits operations into ≤3-step sub-tasks with extracted skillHints, dispatches them sequentially via WebSocket `subtask.execute` messages, and handles each `subtask.result` status (success/failed/blocked/timeout/stopped) with the decision logic from §6.2.

**Tech Stack:** TypeScript, Zod, ws (WebSocket), yaml (frontmatter parsing)

---

## File Structure

### New Files

| File | Responsibility |
|------|---------------|
| `src/skill-types.ts` | Shared skill data types (mirror of TabbyApp SkillModels.kt): GlobalHandler, StrategyChain, Operation, Step, SkillHint, etc. |
| `src/skill-parser.ts` | Parses SKILL.md (YAML frontmatter + Markdown body) into AppSkill |
| `src/skill-manager.ts` | Loads/caches SKILL.md files by package name; resolves intents & handlers |
| `src/orchestrator.ts` | Core orchestrator: decomposes task → operation calls → sub-task splits → sequential dispatch → dynamic adjustment |
| `src/skills/` | Directory for desktop-side SKILL.md files (symlink or copy from phone project initially) |

### Modified Files

| File | Change |
|------|--------|
| `src/protocol.ts` | Add sub-task types: SubTaskExecuteParams, SubTaskResult, SkillHintSchema, SubTaskStatus enum |
| `src/task-coordinator.ts` | Add executeSubTask() method, handleSubTaskMessage() routing, pending sub-task Map |
| `src/tools.ts` | Add `device_execute_skill` tool (skill-aware task execution) |
| `src/mcp-server.ts` | Add `device_execute_skill` to MCP tool list |
| `src/index.ts` | Wire Orchestrator, SkillManager; add new tool registration |

---

## Task 1: Sub-task Protocol Types (protocol.ts)

**Files:**
- Modify: `src/protocol.ts`

- [ ] **Step 1: Add SkillHint and Sub-task schemas**

Add after `ExecuteParamsSchema`:

```typescript
// ─── Skill Hint ────────────────────────────────────────────────────────────────

export const SkillHintSchema = z.object({
  targetElement: z.string(),
  strategy: z.string(),
  validation: z.string().optional().default(''),
});
export type SkillHint = z.infer<typeof SkillHintSchema>;

// ─── Sub-task ──────────────────────────────────────────────────────────────────

export const SubTaskStatusSchema = z.enum([
  'success', 'failed', 'blocked', 'timeout', 'stopped',
]);
export type SubTaskStatus = z.infer<typeof SubTaskStatusSchema>;

export const SubTaskExecuteParamsSchema = z.object({
  taskId: TaskIdSchema,
  subtaskId: z.string().min(1),
  goal: z.string().min(1),
  context: z.string().default(''),
  maxSteps: z.number().int().min(1).max(3).default(3),
  timeoutMs: z.number().int().positive().default(15_000),
  skillHint: SkillHintSchema.optional(),
});
export type SubTaskExecuteParams = z.infer<typeof SubTaskExecuteParamsSchema>;

export const SubTaskResultSchema = z.object({
  taskId: TaskIdSchema,
  subtaskId: z.string().min(1),
  status: SubTaskStatusSchema,
  actions: z.array(z.string()).default([]),
  screenshot: z.string().optional(), // base64
  currentState: z.string().default(''),
  blockReason: z.string().default(''),
});
export type SubTaskResult = z.infer<typeof SubTaskResultSchema>;

export const SubTaskHeartbeatSchema = z.object({
  taskId: TaskIdSchema,
  subtaskId: z.string().min(1),
  step: z.number().int().min(0),
  elapsed: z.number().int().nonnegative(),
});
export type SubTaskHeartbeat = z.infer<typeof SubTaskHeartbeatSchema>;
```

- [ ] **Step 2: Update DeviceBridge interface**

Add to the `DeviceBridge` interface:

```typescript
  executeSubTask(deviceId: string, params: SubTaskExecuteParams, timeoutMs?: number): Promise<SubTaskResult>;
```

- [ ] **Step 3: Commit**

```bash
git add src/protocol.ts
git commit -m "feat: add sub-task protocol types and SkillHint schema"
```

---

## Task 2: Skill Data Types (skill-types.ts)

**Files:**
- Create: `src/skill-types.ts`

- [ ] **Step 1: Create skill-types.ts**

```typescript
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

export interface Step {
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
  steps: Step[];
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
```

- [ ] **Step 2: Commit**

```bash
git add src/skill-types.ts
git commit -m "feat: add desktop skill data types mirroring phone SkillModels"
```

---

## Task 3: SKILL.md Parser (skill-parser.ts)

**Files:**
- Create: `src/skill-parser.ts`

- [ ] **Step 1: Create skill-parser.ts**

This mirrors the Kotlin `SkillParser.kt` logic in TypeScript: parse YAML frontmatter + Markdown body tables (risk signals, global handlers with strategy chains, intent routing, operations with steps).

```typescript
import type {
  AppSkill, RiskSignal, GlobalHandler, StrategyChain,
  IntentRoute, Operation, OpParam, Step, StepType, FailureRule,
} from './skill-types.js';

export function parseSkill(markdown: string): AppSkill | null {
  try {
    const [frontmatter, body] = splitFrontmatter(markdown);
    const metadata = parseFrontmatter(frontmatter);
    const riskSignals = parseTableSection<RiskSignal>(body, '风险信号', row => ({
      signal: row[0] ?? '', action: row[1] ?? '',
    }));
    const globalHandlers = parseTableSection<GlobalHandler>(body, '全局弹窗处理', row => ({
      popup: row[0] ?? '',
      identification: row[1] ?? '',
      strategy: row[2] ?? '',
      strategyChain: parseStrategyChain(row[2] ?? ''),
    }));
    const intentRouting = parseTableSection<IntentRoute>(body, '意图路由', row => ({
      intent: row[0] ?? '',
      operation: row[1] ?? '',
      keywords: (row[2] ?? '').split('、').map(s => s.trim()).filter(Boolean),
    }));
    const operations = parseOperations(body);

    return {
      name: metadata['name'] ?? '',
      app: metadata['app'] ?? '',
      version: metadata['version'] ?? '1.0.0',
      description: metadata['description'] ?? '',
      riskSignals,
      globalHandlers,
      intentRouting,
      operations,
    };
  } catch (e) {
    console.error(`[skill-parser] Failed to parse SKILL.md: ${e}`);
    return null;
  }
}
```

Implement `splitFrontmatter`, `parseFrontmatter`, `parseTableSection`, `parseStrategyChain`, `parseOperations` following the same regex/table parsing patterns as `SkillParser.kt`.

Key helper — parseStrategyChain matches `"1. accessibility:\`id/iv_close\` 2. visual:"关闭按钮""`:
```typescript
function parseStrategyChain(strategyStr: string): StrategyChain | undefined {
  const accMatch = strategyStr.match(/accessibility:\s*`?([^`\s)]+)`?/);
  const visMatch = strategyStr.match(/visual:\s*"([^"）]+)"/);
  const acc = accMatch?.[1];
  const vis = visMatch?.[1]?.trim();
  return (acc || vis) ? { accessibilitySelector: acc, visualPrompt: vis } : undefined;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/skill-parser.ts
git commit -m "feat: add SKILL.md parser matching phone-side SkillParser.kt"
```

---

## Task 4: SkillManager (skill-manager.ts)

**Files:**
- Create: `src/skill-manager.ts`
- Create: `src/skills/` directory

- [ ] **Step 1: Create skill-manager.ts**

```typescript
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { AppSkill, GlobalHandler } from './skill-types.js';
import { parseSkill } from './skill-parser.js';

export class SkillManager {
  private cache = new Map<string, AppSkill | null>();
  private skillsDir: string;

  constructor(skillsDir?: string) {
    this.skillsDir = skillsDir ?? path.join(
      path.dirname(fileURLToPath(import.meta.url)), '..', 'skills'
    );
  }

  /** Get skill for app package name */
  getSkill(appPackage: string): AppSkill | null {
    if (this.cache.has(appPackage)) return this.cache.get(appPackage) ?? null;

    const skillFile = path.join(this.skillsDir, appPackage, 'SKILL.md');
    if (!fs.existsSync(skillFile)) {
      this.cache.set(appPackage, null);
      return null;
    }

    const markdown = fs.readFileSync(skillFile, 'utf-8');
    const skill = parseSkill(markdown);
    this.cache.set(appPackage, skill);
    return skill;
  }

  /** Find matching global handler for a popup description */
  findGlobalHandler(appPackage: string, popupDescription: string): GlobalHandler | undefined {
    const skill = this.getSkill(appPackage);
    if (!skill) return undefined;
    return skill.globalHandlers.find(h =>
      popupDescription.toLowerCase().includes(h.popup.toLowerCase()) ||
      popupDescription.toLowerCase().includes(h.identification.toLowerCase())
    );
  }

  /** Resolve user message to an operation name */
  resolveIntent(appPackage: string, userMessage: string): string | undefined {
    const skill = this.getSkill(appPackage);
    if (!skill) return undefined;
    return skill.intentRouting.find(r =>
      r.keywords.some(kw => userMessage.includes(kw))
    )?.operation;
  }

  /** Invalidate cache */
  invalidate(appPackage: string): void {
    this.cache.delete(appPackage);
  }
}
```

- [ ] **Step 2: Create skills directory and symlink XHS skill**

```bash
mkdir -p src/skills
# Either copy or symlink the XHS skill from TabbyApp
cp ../../TabbyApp/app/src/main/assets/skills/com.xingin.xhs/SKILL.md src/skills/com.xingin.xhs/SKILL.md
```

- [ ] **Step 3: Commit**

```bash
git add src/skill-manager.ts src/skills/
git commit -m "feat: add SkillManager for loading/caching SKILL.md files"
```

---

## Task 5: Orchestrator (orchestrator.ts)

**Files:**
- Create: `src/orchestrator.ts`

This is the core new component. It takes a user task + device context → decomposes via SKILL.md → dispatches sub-tasks → handles results dynamically.

- [ ] **Step 1: Create orchestrator.ts**

```typescript
import type { SkillManager } from './skill-manager.js';
import type { TaskCoordinator } from './task-coordinator.js';
import type { SubTaskResult, SubTaskExecuteParams, SkillHint } from './protocol.js';
import type { AppSkill, Operation, Step, StrategyChain } from './skill-types.js';

export interface OrchestrationResult {
  success: boolean;
  message: string;
  completedSubTasks: string[];
  failedSubTasks: string[];
  screenshots: string[];
}

export class Orchestrator {
  constructor(
    private coordinator: TaskCoordinator,
    private skillManager: SkillManager,
  ) {}

  /**
   * Execute a user task using skill-based orchestration.
   * 1. Detect current app → load skill
   * 2. Resolve intent → find operation(s)
   * 3. Split each operation into ≤3-step sub-tasks
   * 4. Dispatch sub-tasks sequentially
   * 5. Handle results dynamically per §6.2
   */
  async executeSkillTask(
    deviceId: string,
    task: string,
    currentApp: string,
    timeoutMs = 600_000,
  ): Promise<OrchestrationResult> {
    // ... full implementation below
  }
}
```

The `executeSkillTask` method implements:

1. **Load skill**: `skillManager.getSkill(currentApp)` — if no skill, fall back to `coordinator.executeTask()` (whole-task mode)
2. **Resolve intent**: `skillManager.resolveIntent(currentApp, task)` — if no match, fall back
3. **Get operation**: `skill.operations.get(operationName)` — validate params from task
4. **Split into sub-tasks**:
   - Each operation's steps are grouped into sub-tasks of ≤3 steps
   - Deterministic steps get skillHint built from their strategy chain
   - Flexible steps get skillHint from their prompt
   - RequiresConfirmation operations split into "fill" and "execute" phases
5. **Sequential dispatch**:
   - For each sub-task, build `SubTaskExecuteParams` and call `coordinator.executeSubTask()`
   - On `success`: proceed to next sub-task
   - On `failed`: retry once, then adjust strategy (skip/modify)
   - On `blocked`: check if globalHandler exists → dispatch handler sub-task → retry
   - On `timeout`: split current goal into smaller sub-tasks
   - On `stopped`: replan from current state
6. **Confirmation flow**: For `requiresConfirmation` ops, the "fill" sub-task reports screenshot + state, orchestrator pauses for caller (AI/user) to confirm

Key internal methods:
- `splitOperationIntoSubTasks(operation, params)` → `SubTaskPlan[]`
- `buildSkillHintFromStep(step: Step)` → `SkillHint | undefined`
- `handleSubTaskResult(result, plan)` → decision (continue/retry/adjust/abort)

```typescript
interface SubTaskPlan {
  subtaskId: string;
  goal: string;
  context: string;
  maxSteps: number;
  timeoutMs: number;
  skillHint?: SkillHint;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/orchestrator.ts
git commit -m "feat: add Orchestrator with skill-based task decomposition and dynamic adjustment"
```

---

## Task 6: TaskCoordinator Sub-task Support (task-coordinator.ts)

**Files:**
- Modify: `src/task-coordinator.ts`

- [ ] **Step 1: Add sub-task pending map and executeSubTask method**

Add a separate map for sub-task pending requests:

```typescript
  private subTaskPending = new Map<string, PendingSubTaskRequest>();

  interface PendingSubTaskRequest {
    resolve: (value: SubTaskResult) => void;
    reject: (reason: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
    deviceId: string;
  }
```

Add `executeSubTask()`:

```typescript
  async executeSubTask(
    deviceId: string,
    params: SubTaskExecuteParams,
    timeoutMs = 60_000,
  ): Promise<SubTaskResult> {
    const device = this.wsServer.getRegistry().get(deviceId);
    if (!device) throw new Error(`DEVICE_NOT_FOUND: no device with id ${deviceId}`);

    const subtaskId = params.subtaskId;

    const sent = this.wsServer.sendToDevice(deviceId, {
      channel: 'task',
      id: `sub_${subtaskId}`,
      method: 'subtask.execute',
      params,
    });

    if (!sent) throw new Error('DEVICE_OFFLINE');

    return this.waitForSubTaskResult(subtaskId, deviceId, timeoutMs);
  }
```

Add `handleSubTaskMessage()`:

```typescript
  handleSubTaskMessage(deviceId: string, message: Record<string, unknown>): void {
    // Route: subtask.result → resolve pending promise
    // Route: subtask.heartbeat → log + IPC notification
    if (message.method === 'subtask.result') {
      const params = message.params as Record<string, unknown>;
      const subtaskId = params.subtaskId as string;
      const pending = this.subTaskPending.get(subtaskId);
      if (pending) {
        clearTimeout(pending.timeout);
        this.subTaskPending.delete(subtaskId);
        const result: SubTaskResult = SubTaskResultSchema.parse(params);
        pending.resolve(result);
      }
    } else if (message.method === 'subtask.heartbeat') {
      // Forward heartbeat for monitoring
      this.ipcNotifier('device:subtask_heartbeat', { deviceId, params: message.params });
    }
  }
```

Add `waitForSubTaskResult()` (same pattern as `waitForResult()`).

- [ ] **Step 2: Wire subtask message routing in existing handleTaskMessage**

In `handleTaskMessage()`, add routing for subtask methods:

```typescript
    const method = message.method as string;
    if (method?.startsWith('subtask.')) {
      this.handleSubTaskMessage(deviceId, message);
      return;
    }
```

- [ ] **Step 3: Commit**

```bash
git add src/task-coordinator.ts
git commit -m "feat: add sub-task execution and result handling to TaskCoordinator"
```

---

## Task 7: WsServer Sub-task Message Routing (ws-server.ts)

**Files:**
- Modify: `src/ws-server.ts`

- [ ] **Step 1: Route subtask.result and subtask.heartbeat messages**

In the `handleConnection` message handler, after the `channel === 'task'` check, add sub-task method detection before the existing `taskMessageHandler` call:

```typescript
        if (channel === 'task') {
          const method = msg.method as string;
          // Route sub-task messages through the same taskMessageHandler
          // (TaskCoordinator.handleTaskMessage will internally delegate to handleSubTaskMessage)
          if (this.taskMessageHandler) {
            this.taskMessageHandler(deviceId!, msg);
          } else {
            this.ipcNotifier('device:task_message', { deviceId, message: msg });
          }
        }
```

No changes needed here since the TaskCoordinator already routes `subtask.*` methods internally. The existing channel routing passes all `task` channel messages to `taskMessageHandler`.

- [ ] **Step 2: Commit (if any changes were needed)**

---

## Task 8: New Tool — device_execute_skill (tools.ts + mcp-server.ts)

**Files:**
- Modify: `src/tools.ts`
- Modify: `src/mcp-server.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Add device_execute_skill tool to tools.ts**

```typescript
export function createExecuteSkillTool(orchestrator: Orchestrator, registry: DeviceRegistry) {
  return {
    name: 'device_execute_skill',
    label: 'Execute Task with Skill Orchestration',
    description: [
      'Execute a task using skill-based sub-task orchestration. Decomposes complex tasks into',
      '≤3-step sub-tasks with skill hints for reliable execution. Use this instead of',
      'device_execute_task when the target app has a known skill definition.',
      '',
      'Benefits over device_execute_task:',
      '- Breaks complex tasks into reliable ≤3-step chunks',
      '- Injects app-specific knowledge (accessibility selectors, visual prompts)',
      '- Handles popups and errors according to app-specific rules',
      '- Supports confirmation flow for write operations (posting, commenting)',
      '',
      'The device MUST have skill support enabled (Tabby Agent app v2+).',
      'Falls back to device_execute_task if no skill is available for the current app.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        deviceId: {
          type: 'string',
          description: 'Device ID from device_list',
        },
        task: {
          type: 'string',
          description: 'Natural language task description (Chinese or English)',
        },
        currentApp: {
          type: 'string',
          description: 'Current app package name (e.g. "com.xingin.xhs"). If omitted, uses device\'s current app.',
        },
        timeout: {
          type: 'number',
          description: 'Overall orchestration timeout in milliseconds (default: 600000)',
          default: 600000,
        },
      },
      required: ['deviceId', 'task'],
    },
    async execute(
      _id: string,
      params: { deviceId?: string; task?: string; currentApp?: string; timeout?: number },
    ): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
      if (!params.deviceId || !params.task) {
        return { content: [{ type: 'text', text: 'deviceId and task are required.' }], isError: true };
      }
      try {
        // Resolve currentApp if not provided
        let currentApp = params.currentApp;
        if (!currentApp) {
          const deviceInfo = registry.get(params.deviceId)?.info;
          currentApp = deviceInfo?.currentApp ?? '';
        }

        const result = await orchestrator.executeSkillTask(
          params.deviceId,
          params.task,
          currentApp,
          Math.min(params.timeout ?? 600_000, 600_000),
        );

        const sections: string[] = [];
        if (result.success) {
          sections.push(`✅ Skill task completed`);
        } else {
          sections.push(`❌ Skill task failed: ${result.message}`);
        }
        sections.push(`Sub-tasks completed: ${result.completedSubTasks.length}`);
        sections.push(`Sub-tasks failed: ${result.failedSubTasks.length}`);
        if (result.completedSubTasks.length > 0) {
          sections.push(`Completed: ${result.completedSubTasks.join(', ')}`);
        }
        if (result.failedSubTasks.length > 0) {
          sections.push(`Failed: ${result.failedSubTasks.join(', ')}`);
        }
        // Include last screenshot if available
        if (result.screenshots.length > 0) {
          const last = result.screenshots[result.screenshots.length - 1];
          if (last.startsWith('/')) {
            sections.push(`\n📸 Final screenshot: ${last}`);
          }
        }

        return { content: [{ type: 'text', text: sections.join('\n') }], isError: !result.success };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `device_execute_skill failed: ${msg}` }], isError: true };
      }
    },
  };
}
```

- [ ] **Step 2: Add tool to MCP server tools/list in mcp-server.ts**

In the `tools/list` case, add:

```typescript
              {
                name: "device_execute_skill",
                description: "Execute a task with skill-based sub-task orchestration. Decomposes complex tasks into reliable ≤3-step chunks with app-specific knowledge. Use when target app has a known skill.",
                inputSchema: {
                  type: "object",
                  properties: {
                    deviceId: { type: "string", description: "Device ID from device_list" },
                    task: { type: "string", description: "Natural language task" },
                    currentApp: { type: "string", description: "Current app package name (optional)" },
                    timeoutMs: { type: "number", description: "Timeout in ms", default: 600000 },
                  },
                  required: ["deviceId", "task"],
                },
              },
```

In the `tools/call` case, add:

```typescript
            case 'device_execute_skill': {
              let currentApp = args.currentApp as string | undefined;
              if (!currentApp) {
                const info = wsServer.getRegistry().get(args.deviceId as string)?.info;
                currentApp = info?.currentApp ?? '';
              }
              const result = await orchestrator.executeSkillTask(
                args.deviceId as string,
                args.task as string,
                currentApp ?? '',
                (args.timeoutMs as number) ?? 600_000,
              );
              this.send(id, {
                content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
                isError: !result.success,
              });
              break;
            }
```

- [ ] **Step 3: Wire Orchestrator + SkillManager in index.ts**

```typescript
import { SkillManager } from './skill-manager.js';
import { Orchestrator } from './orchestrator.js';

// In the register() method, after coordinator creation:
const skillManager = new SkillManager();
const orchestrator = new Orchestrator(coordinator, skillManager);

// Add tool registration:
import { createExecuteSkillTool } from './tools.js';
api.registerTool(makeTool(createExecuteSkillTool), { orchestrator, registry: wsServer.getRegistry() });

// Update InProcessBridge to also expose orchestrator:
// Add executeSubTask delegation
```

- [ ] **Step 4: Commit**

```bash
git add src/tools.ts src/mcp-server.ts src/index.ts
git commit -m "feat: add device_execute_skill tool with orchestrator wiring"
```

---

## Task 9: Standalone Mode Integration (standalone.ts)

**Files:**
- Modify: `src/standalone.ts`

- [ ] **Step 1: Wire SkillManager + Orchestrator in standalone mode**

Same pattern as index.ts: create SkillManager, Orchestrator, pass to RPC methods.

- [ ] **Step 2: Commit**

```bash
git add src/standalone.ts
git commit -m "feat: add skill orchestration to standalone mode"
```

---

## Task 10: Build Verification

- [ ] **Step 1: Install yaml dependency if needed for frontmatter parsing**

```bash
cd /Users/zongkelong/workspace/tabby-control
npm install yaml  # or js-yaml — whichever is preferred
```

Alternatively, implement a simple YAML frontmatter parser without dependencies (like the Kotlin version does with regex).

- [ ] **Step 2: Run TypeScript build**

```bash
npx tsc --noEmit
```

Expected: No type errors.

- [ ] **Step 3: Fix any compilation issues**

- [ ] **Step 4: Run full build**

```bash
npm run build
```

Expected: BUILD SUCCESSFUL

- [ ] **Step 5: Commit any fixes**

```bash
git add -A && git commit -m "fix: resolve compilation issues from skill orchestration integration"
```

---

## Spec Coverage Check

| Spec Section | Task(s) |
|---|---|
| §6.1 任务分解流程 | Task 5 (Orchestrator.splitOperationIntoSubTasks) |
| §6.2 动态调整决策 | Task 5 (Orchestrator.handleSubTaskResult) |
| §6.3 写操作确认流程 | Task 5 (Orchestrator confirmation flow) |
| §4.1 新增消息类型 | Task 1, 6 (protocol + coordinator) |
| §4.2 状态枚举与决策映射 | Task 1 (SubTaskStatus enum) |
| §4.3 向后兼容 | Task 5 (fallback to executeTask) |
| §5.1 技能文档格式 | Task 2, 3 (types + parser) |
| §5.3 双端协作 | Task 4, 5 (SkillManager + Orchestrator) |
