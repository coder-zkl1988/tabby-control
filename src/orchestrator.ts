import type { TaskCoordinator } from './task-coordinator.js';
import type { OrchestrationResult, SubTaskExecuteParams, SkillHint, SubTaskStatus } from './protocol.js';
import type { SkillStep, Handler } from './skill-types.js';

interface SubTaskPlan {
  subtaskId: string;
  goal: string;
  context: string;
  maxSteps: number;
  timeoutMs: number;
  skillHint?: SkillHint;
}

interface OrchestrationState {
  deviceId: string;
  taskId: string;
  currentSubTaskIdx: number;
  plans: SubTaskPlan[];
  completed: string[];
  failed: string[];
  screenshots: string[];
  startTime: number;
  timeoutMs: number;
}

export class Orchestrator {
  constructor(
    private coordinator: TaskCoordinator,
  ) {}

  private activeOrchestrations = new Map<string, OrchestrationState>();

  /**
   * Execute a user task using skill-based orchestration.
   * Steps and handlers come from the LLM — this method mechanically dispatches them.
   */
  async executeSkillTask(
    deviceId: string,
    task: string,
    steps: SkillStep[],
    handlers: Handler[] = [],
    timeoutMs = 600_000,
  ): Promise<OrchestrationResult> {
    const taskId = `t_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const completed: string[] = [];
    const failed: string[] = [];
    const screenshots: string[] = [];
    const startTime = Date.now();

    // Build sub-task plans from LLM-provided steps (one plan per step)
    const plans: SubTaskPlan[] = steps.map((step, idx) => ({
      subtaskId: `st_${taskId}_${idx}`,
      goal: step.name,
      context: `任务: ${task}, 步骤: ${step.name}`,
      maxSteps: Math.min(step.maxSteps ?? (step.type === 'flexible' ? 2 : 1), 3),
      timeoutMs: 15_000 * Math.ceil(step.maxSteps ?? 1),
      skillHint: this.buildSkillHint(step),
    }));

    // Send task.start to phone with handlers
    await this.coordinator.sendTaskStart(deviceId, { taskId, handlers });

    try {
      return await this.runDispatchLoop(
        deviceId, taskId, plans, handlers,
        completed, failed, screenshots, startTime, timeoutMs,
      );
    } finally {
      // Always send task.end
      await this.coordinator.sendTaskEnd(deviceId, { taskId });
    }
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
        state.deviceId, taskId, state.plans, resumeIdx,
        state.completed, state.failed, state.screenshots,
        state.startTime, state.timeoutMs,
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
   * Build a skill hint from a step for the sub-task dispatch.
   */
  private buildSkillHint(step: SkillStep): SkillHint {
    return {
      targetElement: step.action || step.name,
      action: step.action || '',
      validation: step.validation || '',
    };
  }

  /**
   * Dispatch loop — dispatches sub-tasks sequentially, handles retries and interruptions.
   */
  private async runDispatchLoop(
    deviceId: string,
    taskId: string,
    plans: SubTaskPlan[],
    handlers: Handler[],
    completed: string[],
    failed: string[],
    screenshots: string[],
    startTime: number,
    timeoutMs: number,
  ): Promise<OrchestrationResult> {
    let retryCount = 0;
    const maxRetries = 1;
    let i = 0;
    let lastCurrentState = '';

    while (i < plans.length) {
      if (Date.now() - startTime > timeoutMs) {
        failed.push(...plans.slice(i).map(p => p.subtaskId));
        break;
      }

      const plan = plans[i];

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
          case 'needs_confirmation':
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
              retryCount = 0;
              i++;
            }
            break;

          case 'blocked': {
            const handler = handlers.find(h =>
              result.blockReason.toLowerCase().includes(h.trigger.toLowerCase()) ||
              h.trigger.toLowerCase().includes(result.blockReason.toLowerCase())
            );
            if (handler) {
              console.log(`[Orchestrator] Blocked by interrupt, dispatching handler: ${handler.name}`);
              const handlerPlan: SubTaskPlan = {
                subtaskId: `${plan.subtaskId}_handler_${Date.now()}`,
                goal: `处理中断: ${handler.name}`,
                context: result.blockReason,
                maxSteps: 2,
                timeoutMs: 10_000,
                skillHint: {
                  targetElement: handler.action ?? handler.name,
                  action: handler.action ?? '',
                  validation: '',
                },
              };
              try {
                const handlerResult = await this.coordinator.executeSubTask(deviceId, {
                  taskId,
                  ...handlerPlan,
                });
                if (handlerResult.status === 'success') {
                  console.log(`[Orchestrator] Interrupt handled, retrying subtask`);
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

          case 'timeout':
            console.log(`[Orchestrator] SubTask timed out, marking failed`);
            failed.push(plan.subtaskId);
            i++;
            break;

          case 'stopped':
            console.log(`[Orchestrator] SubTask stopped, marking failed`);
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
   * Run remaining plans from a starting index (for resume after confirmation).
   */
  private async runRemainingPlans(
    deviceId: string,
    taskId: string,
    plans: SubTaskPlan[],
    startIndex: number,
    completed: string[],
    failed: string[],
    screenshots: string[],
    startTime: number,
    timeoutMs: number,
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

      console.log(`[Orchestrator] Dispatching subtask [${plan.subtaskId}]: ${plan.goal}`);

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
          case 'needs_confirmation':
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
              retryCount = 0;
              i++;
            }
            break;

          case 'blocked':
            failed.push(plan.subtaskId);
            i++;
            break;

          case 'timeout':
          case 'stopped':
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
}
