const DEFAULT_TASK_TIMEOUT_MS = 300_000;
const TASK_REQUEST_HEADROOM_MS = 30_000;

export function resolveTaskRequestTimeoutMs(scenario) {
  if (scenario.requestTimeoutMs != null) return scenario.requestTimeoutMs;

  const inactivityTimeoutMs = scenario.task?.timeoutMs ?? DEFAULT_TASK_TIMEOUT_MS;
  return Math.max(
    DEFAULT_TASK_TIMEOUT_MS,
    inactivityTimeoutMs + TASK_REQUEST_HEADROOM_MS,
  );
}
