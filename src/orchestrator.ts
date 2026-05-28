import type { TaskCoordinator } from './task-coordinator.js';
import type { SkillManager } from './skill-manager.js';
import type { OrchestrationResult, SubTaskExecuteParams, SkillHint, SubTaskStatus } from './protocol.js';
import type { AppSkill, GlobalHandler, Operation, SkillStep } from './skill-types.js';

interface SubTaskPlan {
  subtaskId: string;
  goal: string;
  context: string;
  maxSteps: number;
  timeoutMs: number;
  skillHint?: SkillHint;
  phase?: 'fill' | 'execute'; // for requiresConfirmation ops
}

interface OrchestrationState {
  deviceId: string;
  taskId: string;
  currentSubTaskIdx: number;
  plans: SubTaskPlan[];
  operation: Operation;
  completed: string[];
  failed: string[];
  screenshots: string[];
  startTime: number;
  timeoutMs: number;
  currentApp: string;
}

export class Orchestrator {
  constructor(
    private coordinator: TaskCoordinator,
    private skillManager: SkillManager,
  ) {}

  private activeOrchestrations = new Map<string, OrchestrationState>();

  /**
   * Execute a user task using skill-based orchestration per spec §6.
   * 1. Load skill for current app
   * 2. Resolve intent → find operation
   * 3. Split operation into ≤3-step sub-tasks
   * 4. Dispatch sequentially, adjust dynamically
   */
  async executeSkillTask(
    deviceId: string,
    task: string,
    currentApp: string,
    timeoutMs = 600_000,
  ): Promise<OrchestrationResult> {
    const taskId = `t_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const completed: string[] = [];
    const failed: string[] = [];
    const screenshots: string[] = [];
    const startTime = Date.now();

    // 1. Load skill
    const skill = this.skillManager.getSkill(currentApp);
    if (!skill) {
      // Fallback to whole-task mode
      console.log(`[Orchestrator] No skill for ${currentApp}, falling back to whole-task`);
      const result = await this.coordinator.executeTask(deviceId, task, timeoutMs);
      return {
        success: result.success,
        message: result.message ?? '',
        status: result.success ? 'completed' : 'failed',
        completedSubTasks: result.success ? ['whole_task'] : [],
        failedSubTasks: result.success ? [] : ['whole_task'],
        screenshots: result.finalScreenshot ? [result.finalScreenshot] : [],
      };
    }

    // 2. Resolve intent
    const operationName = this.skillManager.resolveIntent(currentApp, task);
    if (!operationName) {
      // No matching intent, fall back
      console.log(`[Orchestrator] No matching intent in skill for: "${task}", falling back`);
      const result = await this.coordinator.executeTask(deviceId, task, timeoutMs);
      return {
        success: result.success,
        message: result.message ?? '',
        status: result.success ? 'completed' : 'failed',
        completedSubTasks: result.success ? ['whole_task'] : [],
        failedSubTasks: result.success ? [] : ['whole_task'],
        screenshots: result.finalScreenshot ? [result.finalScreenshot] : [],
      };
    }

    // 3. Get operation
    const operation = skill.operations.get(operationName);
    if (!operation) {
      return {
        success: false,
        message: `Operation "${operationName}" not found in skill`,
        status: 'failed',
        completedSubTasks: [],
        failedSubTasks: [],
        screenshots: [],
      };
    }

    console.log(`[Orchestrator] Resolved: "${task}" → operation "${operationName}" (${operation.steps.length} steps)`);

    // 4. Split into sub-tasks
    const plans = this.splitOperationIntoSubTasks(taskId, operation, task);
    
    // 5. Execute via shared orchestration loop
    return this.runRemainingPlans(
      deviceId, taskId, plans, operation, 0,
      completed, failed, screenshots, startTime, timeoutMs, currentApp,
    );
  }

  /**
   * Resume a paused orchestration after user confirms or cancels.
   */
  async resumeOrchestration(
    deviceId: string,
    taskId: string,
    subtaskId: string,
    confirmed: boolean,
  ): Promise<OrchestrationResult> {
    const state = this.activeOrchestrations.get(taskId);
    if (!state) {
      return {
        success: false,
        message: 'No paused orchestration found for this task',
        status: 'failed',
        completedSubTasks: [],
        failedSubTasks: [],
        screenshots: [],
      };
    }

    if (confirmed) {
      console.log(`[Orchestrator] Resuming orchestration ${taskId} from subtask ${subtaskId}`);
      const resumeIdx = state.plans.findIndex(p => p.subtaskId === subtaskId);
      if (resumeIdx < 0) {
        this.activeOrchestrations.delete(taskId);
        return {
          success: false,
          message: `Subtask ${subtaskId} not found in orchestration plans`,
          status: 'failed',
          completedSubTasks: [...state.completed],
          failedSubTasks: [...state.failed],
          screenshots: [...state.screenshots],
        };
      }

      const result = await this.runRemainingPlans(
        state.deviceId, taskId, state.plans, state.operation, resumeIdx,
        state.completed, state.failed, state.screenshots,
        state.startTime, state.timeoutMs, state.currentApp,
        true, // skipConfirmationCheck — user already confirmed
      );

      this.activeOrchestrations.delete(taskId);
      return result;
    } else {
      console.log(`[Orchestrator] User cancelled orchestration ${taskId} at subtask ${subtaskId}`);
      const remainingIdx = state.plans.findIndex(p => p.subtaskId === subtaskId);
      if (remainingIdx >= 0) {
        state.failed.push(...state.plans.slice(remainingIdx).map(p => p.subtaskId));
      }

      this.activeOrchestrations.delete(taskId);
      return {
        success: false,
        message: `Orchestration cancelled by user. Completed: ${state.completed.length}, failed: ${state.failed.length}`,
        status: 'failed',
        completedSubTasks: [...state.completed],
        failedSubTasks: [...state.failed],
        screenshots: [...state.screenshots],
      };
    }
  }

  /**
   * Run a set of sub-task plans from a starting index.
   * Handles the main execution loop, dynamic adjustment, and popup handling.
   * Can optionally skip the confirmation check (for resume after user confirms).
   */
  private async runRemainingPlans(
    deviceId: string,
    taskId: string,
    plans: SubTaskPlan[],
    operation: Operation,
    startIndex: number,
    completed: string[],
    failed: string[],
    screenshots: string[],
    startTime: number,
    timeoutMs: number,
    currentApp: string,
    skipConfirmationCheck = false,
  ): Promise<OrchestrationResult> {
    let retryCount = 0;
    const maxRetries = 1;
    let i = startIndex;
    let lastCurrentState = '';

    while (i < plans.length) {
      if (Date.now() - startTime > timeoutMs) {
        failed.push(...plans.slice(i).map(p => p.subtaskId));
        break;
      }

      const plan = plans[i];

      // Before dispatching execute phase, check if confirmation is needed
      if (!skipConfirmationCheck && plan.phase === 'execute' && operation.requiresConfirmation) {
        const orchState: OrchestrationState = {
          deviceId,
          taskId,
          currentSubTaskIdx: i,
          plans,
          operation,
          completed: [...completed],
          failed: [...failed],
          screenshots: [...screenshots],
          startTime,
          timeoutMs,
          currentApp,
        };
        this.activeOrchestrations.set(taskId, orchState);

        console.log(`[Orchestrator] Paused for confirmation at subtask [${plan.subtaskId}]: ${plan.goal}`);
        return {
          success: true,
          message: `Fill phase complete. Confirmation needed for: ${plan.goal}`,
          status: 'needs_confirmation',
          taskId,
          completedSubTasks: [...completed],
          failedSubTasks: [...failed],
          screenshots: [...screenshots],
          pendingSubTaskId: plan.subtaskId,
          pendingContent: {
            screenshot: screenshots.length > 0 ? screenshots[screenshots.length - 1] : '',
            currentState: lastCurrentState,
            executeGoal: plan.goal,
          },
        };
      }

      console.log(`[Orchestrator] Dispatching subtask [${plan.subtaskId}]: ${plan.goal}${plan.skillHint ? ` (hint: ${plan.skillHint.targetElement})` : ''}`);

      const params: SubTaskExecuteParams = {
        taskId,
        subtaskId: plan.subtaskId,
        goal: plan.goal,
        context: plan.context,
        maxSteps: plan.maxSteps,
        timeoutMs: plan.timeoutMs,
        skillHint: plan.skillHint,
      };

      try {
        const result = await this.coordinator.executeSubTask(deviceId, params);

        if (result.screenshot) {
          screenshots.push(result.screenshot);
        }
        if (result.currentState) {
          lastCurrentState = result.currentState;
        }

        switch (result.status) {
          case 'success':
            completed.push(plan.subtaskId);
            retryCount = 0;
            i++;
            break;

          case 'needs_confirmation':
            // Sub-task level confirmation — treat as success for flow continuity
            completed.push(plan.subtaskId);
            retryCount = 0;
            i++;
            break;

          case 'failed':
            if (retryCount < maxRetries) {
              console.log(`[Orchestrator] SubTask failed, retrying (${retryCount + 1}/${maxRetries})`);
              retryCount++;
            } else {
              failed.push(plan.subtaskId);
              const rule = operation.failureHandling.find(r =>
                result.currentState.includes(r.scenario) || result.blockReason.includes(r.scenario)
              );
              if (rule && (rule.action === '跳过' || rule.action.startsWith('skip'))) {
                console.log(`[Orchestrator] Failure rule: skip → continuing`);
                retryCount = 0;
                i++;
              } else {
                failed.push(...plans.slice(i + 1).map(p => p.subtaskId));
                i = plans.length;
              }
            }
            break;

          case 'blocked': {
            const handler = this.skillManager.findGlobalHandler(currentApp, result.blockReason);
            if (handler) {
              console.log(`[Orchestrator] Blocked by popup, dispatching handler: ${handler.popup}`);
              const handlerPlan: SubTaskPlan = {
                subtaskId: `${plan.subtaskId}_handler_${Date.now()}`,
                goal: `处理弹窗: ${handler.popup}`,
                context: result.blockReason,
                maxSteps: 2,
                timeoutMs: 10_000,
                skillHint: this.buildSkillHintFromHandler(handler),
              };
              try {
                const handlerResult = await this.coordinator.executeSubTask(deviceId, {
                  taskId,
                  ...handlerPlan,
                });
                if (handlerResult.status === 'success') {
                  console.log(`[Orchestrator] Popup handled, retrying subtask`);
                } else {
                  failed.push(plan.subtaskId);
                  i++;
                }
              } catch {
                failed.push(plan.subtaskId);
                i++;
              }
            } else {
              failed.push(plan.subtaskId);
              i++;
            }
            break;
          }

          case 'timeout': {
            console.log(`[Orchestrator] SubTask timed out, splitting goal`);
            const smaller = this.splitGoalSmaller(plan, taskId);
            if (smaller.length > 0 && smaller.length < 4) {
              plans.splice(i, 1, ...smaller);
            } else {
              failed.push(plan.subtaskId);
              i++;
            }
            break;
          }

          case 'stopped':
            console.log(`[Orchestrator] SubTask stopped, replanning`);
            failed.push(plan.subtaskId);
            retryCount = 0;
            i++;
            break;
        }
      } catch (err) {
        console.error(`[Orchestrator] SubTask execution error: ${err}`);
        if (retryCount < maxRetries) {
          retryCount++;
        } else {
          failed.push(plan.subtaskId);
          retryCount = 0;
          i++;
        }
      }
    }

    // Clean up state on completion
    this.activeOrchestrations.delete(taskId);

    const success = failed.length === 0 && completed.length > 0;
    return {
      success,
      message: success
        ? `Task completed: ${completed.length} sub-tasks`
        : `Task partially failed: ${completed.length} ok, ${failed.length} failed`,
      status: success ? 'completed' : 'failed',
      completedSubTasks: completed,
      failedSubTasks: failed,
      screenshots,
    };
  }

  /**
   * Split an operation's steps into ≤3-step sub-tasks per §6.1
   */
  private splitOperationIntoSubTasks(taskId: string, operation: Operation, task: string): SubTaskPlan[] {
    const plans: SubTaskPlan[] = [];
    let group: SkillStep[] = [];
    let subtaskIdx = 0;

    for (const step of operation.steps) {
      group.push(step);
      const effectiveMax = step.maxSteps ?? (step.type === 'flexible' ? 2 : 1);
      const groupSteps = group.reduce((sum, s) => sum + (s.maxSteps ?? (s.type === 'flexible' ? 2 : 1)), 0);

      if (groupSteps >= 3 || step === operation.steps[operation.steps.length - 1]) {
        const subtaskId = `st_${taskId}_${subtaskIdx}`;
        const goals = group.map(s => s.name).join(' → ');
        const hint = this.buildSkillHintFromStep(group[0]); // hint from first step in group

        plans.push({
          subtaskId,
          goal: goals,
          context: `任务: ${task}, 步骤: ${goals}`,
          maxSteps: Math.min(groupSteps, 3),
          timeoutMs: 15_000 * Math.ceil(groupSteps),
          skillHint: hint,
        });

        // For requiresConfirmation ops, insert a confirmation checkpoint after fill steps
        if (operation.requiresConfirmation && subtaskIdx === 0 && operation.steps.length > 1) {
          // First sub-task fills content, second executes
          plans[plans.length - 1].phase = 'fill';
        }

        group = [];
        subtaskIdx++;
      }
    }

    // For requiresConfirmation: split into fill + execute phases
    if (operation.requiresConfirmation && plans.length === 1 && operation.steps.length > 1) {
      // Re-split: first group = fill (non-final steps), second = execute (final step)
      const fillSteps = operation.steps.slice(0, -1);
      const execStep = operation.steps[operation.steps.length - 1];

      plans.length = 0;
      plans.push({
        subtaskId: `st_${taskId}_0`,
        goal: fillSteps.map(s => s.name).join(' → '),
        context: `任务: ${task}（填写阶段）`,
        maxSteps: 3,
        timeoutMs: 30_000,
        skillHint: this.buildSkillHintFromStep(fillSteps[0]),
        phase: 'fill',
      });
      plans.push({
        subtaskId: `st_${taskId}_1`,
        goal: execStep.name,
        context: `任务: ${task}（确认执行阶段）`,
        maxSteps: 1,
        timeoutMs: 15_000,
        skillHint: this.buildSkillHintFromStep(execStep),
        phase: 'execute',
      });
    }

    return plans;
  }

  private buildSkillHintFromStep(step: SkillStep): SkillHint | undefined {
    if (step.action) {
      return {
        targetElement: step.action,
        action: step.action,
        validation: step.validation ?? '',
      };
    }
    if (step.prompt) {
      return {
        targetElement: step.name,
        action: step.prompt,
        validation: step.validation ?? '',
      };
    }
    return undefined;
  }

  private buildSkillHintFromHandler(handler: GlobalHandler): SkillHint {
    return {
      targetElement: handler.action,
      action: handler.action,
      validation: '',
    };
  }

  /**
   * Split a timed-out sub-task into smaller pieces per §6.2
   */
  private splitGoalSmaller(plan: SubTaskPlan, taskId: string): SubTaskPlan[] {
    // Simple heuristic: split the goal at "→" if compound, otherwise can't split
    const parts = plan.goal.split(' → ');
    if (parts.length < 2) return []; // can't split further

    return parts.map((part, idx) => ({
      subtaskId: `${plan.subtaskId}_split_${idx}`,
      goal: part.trim(),
      context: `拆分自: ${plan.goal}`,
      maxSteps: 1,
      timeoutMs: 15_000,
      skillHint: undefined, // lost fine-grained hints when splitting
    }));
  }
}
