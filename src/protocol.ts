/**
 * tabby-control protocol
 *
 * All shared types and Zod schemas for the tabby-control plugin.
 * Single source of truth — imported by ws-server.ts, task-coordinator.ts, tools.ts.
 */

import { z } from 'zod';

// ─── Primitives ───────────────────────────────────────────────────────────────

export const DeviceIdSchema = z.string().min(1);
export type DeviceId = z.infer<typeof DeviceIdSchema>;

export const TaskIdSchema = z.string().min(1);
export type TaskId = z.infer<typeof TaskIdSchema>;

export const TimestampSchema = z.number().int().positive();
export type Timestamp = z.infer<typeof TimestampSchema>;

// ─── Auth ────────────────────────────────────────────────────────────────────

export const DeviceCapabilitiesSchema = z.object({
  model: z.string().optional(),
  osVersion: z.union([z.number(), z.string()]).optional(), // number=SDK, string="Android XX"
  screenWidth: z.number().optional(),
  screenHeight: z.number().optional(),
  manufacturer: z.string().optional(),
  currentApp: z.string().optional(),
  batteryLevel: z.number().optional(),      // 0-100
  batteryStatus: z.string().optional(),     // "charging" | "discharging" | "full" | "unknown"
  totalRam: z.number().optional(),           // bytes
  availableRam: z.number().optional(),      // bytes
  totalStorage: z.number().optional(),      // bytes
  availableStorage: z.number().optional(),  // bytes
  wifiSsid: z.string().optional(),
  isWifiConnected: z.boolean().optional(),
  isCharging: z.boolean().optional(),
  /**
   * The phone's action vocabulary, reported so this side never has to keep a
   * copy of it. The phone resolves an `allowedActions` whitelist by intersecting
   * it with this set, so a name outside it contributes nothing — a whitelist of
   * only unrecognised names silently becomes deny-all. Knowing the real
   * vocabulary lets us reject such a whitelist with a readable error instead.
   */
  supportedActions: z.array(z.string().min(1)).optional(),
  /** Alternate spellings the phone folds into a canonical action, e.g. TAP → CLICK. */
  actionAliases: z.record(z.string().min(1), z.string().min(1)).optional(),
});
export type DeviceCapabilities = z.infer<typeof DeviceCapabilitiesSchema>;

/** A phone's action vocabulary, indexed for lookup. */
export interface PhoneActionVocabulary {
  actions: ReadonlySet<string>;
  aliases: Readonly<Record<string, string>>;
}

/**
 * Index the vocabulary a phone reported at auth. Returns undefined when the
 * phone reported none, in which case callers must skip validation rather than
 * fall back to a hardcoded table — a stale local copy is exactly the drift this
 * reporting exists to remove.
 */
export function buildPhoneActionVocabulary(
  capabilities?: DeviceCapabilities,
): PhoneActionVocabulary | undefined {
  if (!capabilities?.supportedActions?.length) return undefined;
  return {
    actions: new Set(capabilities.supportedActions.map((action) => action.trim().toUpperCase())),
    aliases: Object.fromEntries(
      Object.entries(capabilities.actionAliases ?? {}).map(
        ([alias, canonical]) => [alias.trim().toUpperCase(), canonical.trim().toUpperCase()],
      ),
    ),
  };
}

/** Resolve an action name the way the reporting phone will resolve it. */
export function normalizePhoneAction(
  value: string,
  vocabulary?: PhoneActionVocabulary,
): string {
  const upper = value.trim().toUpperCase();
  return vocabulary?.aliases[upper] ?? upper;
}

export const AuthMessageSchema = z.object({
  type: z.literal('auth'),
  token: z.string(),
  deviceId: DeviceIdSchema,
  capabilities: DeviceCapabilitiesSchema.optional(),
});
export type AuthMessage = z.infer<typeof AuthMessageSchema>;

export const ConnectedMessageSchema = z.object({
  type: z.literal('connected'),
  serverSessionId: z.string(),
});
export type ConnectedMessage = z.infer<typeof ConnectedMessageSchema>;

// ─── Channels ─────────────────────────────────────────────────────────────────

export const ChannelSchema = z.union([
  z.literal('task'),
  z.literal('mirror'),
  z.literal('control'),
  z.literal('skill'),
]);
export type Channel = z.infer<typeof ChannelSchema>;

// ─── Phone Skill Channel ────────────────────────────────────────────────────

export const PhoneSkillExampleStepSchema = z.object({
  observe: z.string(),
  action: z.string(),
});

export const PhoneSkillExampleSchema = z.object({
  scenario: z.string().min(1),
  steps: z.array(PhoneSkillExampleStepSchema).min(1),
});

export const PhoneSubskillSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  file: z.string().min(1),
  keywords: z.array(z.string()),
  content: z.string(),
  priority: z.number().int().default(0),
  requiresCapabilities: z.array(z.string().min(1)).default([]),
});

export const PhoneSkillKindSchema = z.enum(['system', 'oem', 'app']);

export const PhoneSkillActivationSchema = z.object({
  intents: z.array(z.string().min(1)).default([]),
  taskKeywords: z.array(z.string().min(1)).default([]),
  packages: z.array(z.string().min(1)).default([]),
  manufacturers: z.array(z.string().min(1)).min(1).default(['*']),
  androidApiMin: z.number().int().positive().default(26),
  taskScoped: z.boolean().default(false),
  surfaceScoped: z.boolean().default(false),
});

export const PhoneSkillSchema = z.object({
  id: z.string().min(1),
  kind: PhoneSkillKindSchema.default('app'),
  targetPackages: z.array(z.string().min(1)).default([]),
  name: z.string().min(1),
  version: z.number().int().positive(),
  instructions: z.string(),
  activation: PhoneSkillActivationSchema,
  capabilities: z.array(z.string().min(1)).default([]),
  examples: z.array(PhoneSkillExampleSchema).default([]),
  subskills: z.array(PhoneSubskillSchema).default([]),
  priority: z.number().int().default(0),
  author: z.string().min(1).default('system'),
});
export type PhoneSkill = z.infer<typeof PhoneSkillSchema>;

export const PhoneSkillBundleSchema = z.object({
  schemaVersion: z.literal(2),
  bundleVersion: z.number().int().positive(),
  minAppVersion: z.string().min(1),
  skills: z.array(PhoneSkillSchema).min(1),
});
export type PhoneSkillBundle = z.infer<typeof PhoneSkillBundleSchema>;

export const PhoneSkillGeneratedManifestSchema = z.object({
  schemaVersion: z.literal(2),
  bundleVersion: z.number().int().positive(),
  minAppVersion: z.string().min(1),
  digestAlgorithm: z.literal('SHA-256'),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  skills: z.array(z.object({
    id: z.string().min(1),
    kind: PhoneSkillKindSchema,
    version: z.number().int().positive(),
    targetPackages: z.array(z.string().min(1)),
  })).min(1),
});
export type PhoneSkillGeneratedManifest = z.infer<typeof PhoneSkillGeneratedManifestSchema>;

export const PhoneSkillSyncStatusSchema = z.enum([
  'unknown',
  'syncing',
  'current',
  'error',
  'incompatible',
]);
export type PhoneSkillSyncStatus = z.infer<typeof PhoneSkillSyncStatusSchema>;

// ─── Task Channel ────────────────────────────────────────────────────────────

export const AppRoleSchema = z.enum([
  'target_app',
  'official_store',
  'system_installer',
  'system_settings',
  'default_sms',
  'gallery',
  'file_picker',
  'browser',
  'system_dialog',
  'other',
]);
export type AppRole = z.infer<typeof AppRoleSchema>;

// Both policy objects are `.strict()`: an unrecognised key is a hard error, not
// something to drop. These describe a safety posture, and Zod's default of
// stripping unknown keys fails open — the caller believes it applied a
// restriction (`confirmationPolicy: { commenting: 'required' }` is a real
// example) while the phone never receives one and behaves as if unrestricted.
// Rejecting the call tells the caller its key was wrong; silence does not.
export const ConfirmationPolicySchema = z.object({
  login: z.enum(['required', 'forbidden']).optional(),
  publish: z.enum(['required', 'forbidden']).optional(),
  payment: z.literal('forbidden').optional(),
}).strict();

export const TaskPolicySchema = z.object({
  operationClass: z.string().min(1).optional(),
  targetPackages: z.array(z.string().min(1)).optional(),
  allowedAppRoles: z.array(AppRoleSchema).optional(),
  installSourcePolicy: z.literal('official_store_only').optional(),
  allowBrowserDownload: z.boolean().optional(),
  // Validated against the target device's reported vocabulary at dispatch, not
  // here — the schema has no device in scope.
  allowedActions: z.array(z.string().min(1)).optional(),
  allowedApps: z.array(z.string().min(1)).optional(),
  confirmationPolicy: ConfirmationPolicySchema.optional(),
}).strict().superRefine((policy, ctx) => {
  const installOperation =
    policy.operationClass === 'app.install' || policy.operationClass === 'app.update';
  if (installOperation && policy.allowBrowserDownload === true) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['allowBrowserDownload'],
      message: '安装任务禁止浏览器下载',
    });
  }
  if (installOperation && policy.allowedAppRoles?.includes('browser')) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['allowedAppRoles'],
      message: '安装任务不能允许 browser 角色',
    });
  }
});
export type TaskPolicy = z.infer<typeof TaskPolicySchema>;

export const ExecuteParamsSchema = z.object({
  taskId: TaskIdSchema,
  task: z.string().min(1),
  mode: z.enum(['autonomous']).default('autonomous'),
  maxSteps: z.number().int().positive().optional(),
  guidance: z.string().optional(),
  sessionId: z.string().optional(),
  allowedActions: z.array(z.string()).optional(),
  allowedApps: z.array(z.string()).optional(),
  taskPolicy: TaskPolicySchema.optional(),
});
export type ExecuteParams = z.infer<typeof ExecuteParamsSchema>;

// ─── Media Push (server → phone) ─────────────────────────────────────────────
// Pushes an image into the device gallery so an autonomous task can later pick
// it from the album (e.g. publishing a Xiaohongshu post with desktop-uploaded
// images). Sent on the `task` channel (method `media.push`) to reuse the
// existing request/response correlation; the phone replies with MediaPushResult.

export const MediaPushParamsSchema = z.object({
  mediaId: z.string().min(1),
  filename: z.string().min(1),
  mimeType: z.string().min(1),
  /** Base64-encoded image bytes (no data: prefix). */
  dataBase64: z.string().min(1),
});
export type MediaPushParams = z.infer<typeof MediaPushParamsSchema>;

export const MediaPushResultSchema = z.object({
  mediaId: z.string(),
  success: z.boolean(),
  /** Content URI of the saved gallery item when success. */
  savedUri: z.string().optional(),
  error: z.string().optional(),
});
export type MediaPushResult = z.infer<typeof MediaPushResultSchema>;

// ─── Skill Hint ────────────────────────────────────────────────────────────────

export const SkillHintSchema = z.object({
  targetElement: z.string(),
  action: z.string(),
  validation: z.string().optional().default(''),
});
export type SkillHint = z.infer<typeof SkillHintSchema>;

// ─── Sub-task ──────────────────────────────────────────────────────────────────

export const SubTaskStatusSchema = z.enum([
  'success', 'failed', 'blocked', 'timeout', 'stopped', 'needs_confirmation',
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

// ─── Handler schema ───────────────────────────────────────────────────────────────

// Handler schema for interrupt handling rules
export const HandlerSchema = z.object({
  name: z.string(),
  trigger: z.string(),
  strategy: z.enum(['dismiss', 'ignore', 'report']),
  action: z.string().optional(),
});
export type Handler = z.infer<typeof HandlerSchema>;

// Task lifecycle messages
export const TaskStartParamsSchema = z.object({
  taskId: z.string(),
  handlers: z.array(HandlerSchema).default([]),
});
export type TaskStartParams = z.infer<typeof TaskStartParamsSchema>;

export const TaskEndParamsSchema = z.object({
  taskId: z.string(),
});
export type TaskEndParams = z.infer<typeof TaskEndParamsSchema>;

// ─── Orchestration Result ────────────────────────────────────────────────────────

export const OrchestrationResultSchema = z.object({
  success: z.boolean(),
  message: z.string(),
  status: z.enum(['completed', 'needs_confirmation', 'failed']).default('completed'),
  taskId: z.string().optional(),
  completedSubTasks: z.array(z.string()).default([]),
  failedSubTasks: z.array(z.string()).default([]),
  screenshots: z.array(z.string()).default([]),
  // Only present when status = 'needs_confirmation'
  pendingSubTaskId: z.string().optional(),
  pendingContent: z.record(z.unknown()).optional(),
});
export type OrchestrationResult = z.infer<typeof OrchestrationResultSchema>;

export const ResumeParamsSchema = z.object({
  taskId: TaskIdSchema,
  subtaskId: z.string().min(1),
  confirmed: z.boolean(),
});
export type ResumeParams = z.infer<typeof ResumeParamsSchema>;

export const ExecuteBatchParamsSchema = z.object({
  devices: z.array(DeviceIdSchema).min(1),
  tasks: z.array(z.object({
    deviceId: DeviceIdSchema,
    task: z.string().min(1),
  })).min(1),
});
export type ExecuteBatchParams = z.infer<typeof ExecuteBatchParamsSchema>;

export const CancelParamsSchema = z.object({
  taskId: TaskIdSchema,
});
export type CancelParams = z.infer<typeof CancelParamsSchema>;

export const AgentProgressParamsSchema = z.object({
  taskId: TaskIdSchema,
  step: z.number().int().min(1),
  action: z.string(),
  target: z.string().optional(),
  progressPercent: z.number().min(0).max(100),
  thinking: z.string().optional(),
  screenshot: z.string().optional(), // base64 PNG
  interaction_request: z.object({
    message: z.string(),
    screenshot: z.string().optional(),
  }).optional(),
});
export type AgentProgressParams = z.infer<typeof AgentProgressParamsSchema>;

export const AgentArtifactParamsSchema = z.object({
  taskId: TaskIdSchema,
  artifactId: z.string().min(1).max(128),
  name: z.string().min(1).max(256),
  mimeType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
  dataBase64: z.string().min(1),
});
export type AgentArtifactParams = z.infer<typeof AgentArtifactParamsSchema>;

export const TaskArtifactSchema = z.object({
  artifactId: z.string().min(1),
  name: z.string().min(1),
  mimeType: z.string().min(1),
  path: z.string().min(1),
});
export type TaskArtifact = z.infer<typeof TaskArtifactSchema>;

// ─── Step Record ──────────────────────────────────────────────────────────────

export const StepRecordSchema = z.object({
  step: z.number().int().min(1),
  action: z.string(),
  target: z.string().optional(),
  success: z.boolean(),
  error: z.string().optional(),
});
export type StepRecord = z.infer<typeof StepRecordSchema>;

// ─── Task Result ─────────────────────────────────────────────────────────────

export const TaskResultSchema = z.object({
  taskId: TaskIdSchema,
  success: z.boolean(),
  // Final loop status from the phone. Known values: completed | aborted |
  // stuck | needs_takeover | blocked | error. "aborted" is the model's own
  // legitimate decision (task impossible); "error" is an infrastructure
  // failure. Plain string so new phone-side values never reject the result.
  status: z.string().optional(),
  // Phone-side session id, echoed back so guidance replies can be correlated.
  sessionId: z.string().optional(),
  message: z.string().optional(),
  totalSteps: z.number().int().min(0).optional(),
  steps: z.array(StepRecordSchema).optional(),
  failedAtStep: z.number().int().min(1).optional(),
  finalScreenshot: z.string().optional(), // base64 PNG or file path
  duration: z.number().int().nonnegative().optional(), // ms
  needsInteraction: z.boolean().optional(),
  interactionMessage: z.string().optional(),
  interactionScreenshot: z.string().optional(), // file path
  artifacts: z.array(TaskArtifactSchema).optional(),
  errorCode: z.string().optional(),
  policyDecision: z.enum(['allow', 'audit_block', 'block']).optional(),
  blockReason: z.string().optional(),
});
export type TaskResult = z.infer<typeof TaskResultSchema>;

/**
 * A finished task's result, retained after delivery so work is never lost when
 * the caller is gone — an aborted request, a timed-out waiter, or a cancel that
 * raced the phone's answer.
 */
export const CachedTaskResultSchema = z.object({
  taskId: TaskIdSchema,
  deviceId: z.string().min(1),
  result: TaskResultSchema,
  completedAt: TimestampSchema,
  /** True when no caller was awaiting this result at the time it arrived. */
  orphaned: z.boolean(),
});
export type CachedTaskResult = z.infer<typeof CachedTaskResultSchema>;

/** Selector for {@link DeviceBridge.getTaskResults}. */
export interface TaskResultQuery {
  taskId?: string;
  deviceId?: string;
  limit?: number;
}

export const CancelResultSchema = z.object({
  taskId: TaskIdSchema,
  cancelled: z.literal(true),
  stepsCompleted: z.number().int().min(0),
});
export type CancelResult = z.infer<typeof CancelResultSchema>;

// ─── Mirror Channel ───────────────────────────────────────────────────────────

export const DeviceStatusSchema = z.enum(['idle', 'busy', 'error']);
export type DeviceStatus = z.infer<typeof DeviceStatusSchema>;

export const MirrorSnapshotSchema = z.object({
  type: z.enum(['snapshot', 'realtime']),
  screenshot: z.string(), // base64 PNG or JPEG
  /** Image format of the screenshot. Defaults to 'png' for backward compatibility. */
  format: z.enum(['png', 'jpeg', 'webp']).default('png'),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  timestamp: TimestampSchema,
  currentApp: z.string().optional(),
  deviceStatus: DeviceStatusSchema,
});
export type MirrorSnapshot = z.infer<typeof MirrorSnapshotSchema>;

export const MirrorClickParamsSchema = z.object({
  x: z.number().int().nonnegative(),
  y: z.number().int().nonnegative(),
});
export type MirrorClickParams = z.infer<typeof MirrorClickParamsSchema>;

export const MirrorSwipeParamsSchema = z.object({
  startX: z.number().int().nonnegative(),
  startY: z.number().int().nonnegative(),
  endX: z.number().int().nonnegative(),
  endY: z.number().int().nonnegative(),
});
export type MirrorSwipeParams = z.infer<typeof MirrorSwipeParamsSchema>;

export const MirrorTextParamsSchema = z.object({
  text: z.string(),
});
export type MirrorTextParams = z.infer<typeof MirrorTextParamsSchema>;

export const MirrorKeyParamsSchema = z.object({
  key: z.enum(['back', 'home', 'recent']),
});
export type MirrorKeyParams = z.infer<typeof MirrorKeyParamsSchema>;

// ─── Unified Message ─────────────────────────────────────────────────────────

export const RpcRequestSchema = z.object({
  channel: ChannelSchema,
  id: z.string().optional(),
  method: z.string().optional(),
  params: z.record(z.string(), z.unknown()).optional(),
});
export type RpcRequest = z.infer<typeof RpcRequestSchema>;

export const RpcResponseSchema = z.object({
  channel: ChannelSchema,
  id: z.string().optional(),
  result: z.unknown(),
  error: z.object({
    code: z.string(),
    message: z.string(),
  }).optional(),
});
export type RpcResponse = z.infer<typeof RpcResponseSchema>;

// ─── Device Info ─────────────────────────────────────────────────────────────

export const DeviceInfoSchema = z.object({
  deviceId: DeviceIdSchema,
  model: z.string().optional(),
  osVersion: z.union([z.number(), z.string()]).optional(), // number=SDK, string="Android XX"
  screenWidth: z.number().optional(),
  screenHeight: z.number().optional(),
  status: DeviceStatusSchema,
  currentApp: z.string().optional(),
  currentTaskId: TaskIdSchema.optional(),
  connectedAt: TimestampSchema,
  lastSeen: TimestampSchema,
  manufacturer: z.string().optional(),
  batteryLevel: z.number().optional(),
  batteryStatus: z.string().optional(),
  totalRam: z.union([z.number(), z.string()]).optional(),    // bytes | "X.XX GB"
  availableRam: z.union([z.number(), z.string()]).optional(), // bytes | "X.XX GB"
  totalStorage: z.union([z.number(), z.string()]).optional(),    // bytes | "XXX GB"
  availableStorage: z.union([z.number(), z.string()]).optional(), // bytes | "XXX GB"
  wifiSsid: z.string().optional(),
  isWifiConnected: z.boolean().optional(),
  isCharging: z.boolean().optional(),
  skillSchemaVersion: z.number().int().optional(),
  skillBundleVersion: z.number().int().optional(),
  skillDigest: z.string().optional(),
  skillSyncStatus: PhoneSkillSyncStatusSchema.optional(),
  skillSyncError: z.string().optional(),
  skillLastSyncedAt: TimestampSchema.optional(),
  currentOperationClass: z.string().optional(),
  currentAppRole: AppRoleSchema.optional(),
  activeSkills: z.array(z.string()).optional(),
  skippedSkills: z.array(z.string()).optional(),
  deviceSkillLayerMode: z.enum(['off', 'shadow', 'enabled']).optional(),
  devicePolicyMode: z.enum(['off', 'audit', 'enforce']).optional(),
  lastPolicyDecision: z.enum(['allow', 'audit_block', 'block']).optional(),
  lastPolicyCode: z.string().optional(),
  lastBlockedReason: z.string().optional(),
});
export type DeviceInfo = z.infer<typeof DeviceInfoSchema>;

// ─── Error Codes ─────────────────────────────────────────────────────────────

export const DeviceErrorCodeSchema = z.enum([
  'DEVICE_OFFLINE',
  'PERMISSION_DENIED',
  'TIMEOUT',
  'INVALID_PARAMS',
  'SHELL_DENIED',
  'OPERATION_FAILED',
  'DEVICE_NOT_FOUND',
  'TASK_NOT_FOUND',
  'TASK_ALREADY_RUNNING',
  'MAX_DEVICES_REACHED',
]);
export type DeviceErrorCode = z.infer<typeof DeviceErrorCodeSchema>;

// ─── DeviceBridge interface ──────────────────────────────────────────────────────
//
// Shared interface for both BridgeClient (HTTP) and InProcessBridge (direct call).
// Used by tools.ts to work with either bridge implementation.

export interface DeviceBridge {
  ping(): Promise<boolean>;
  listDevices(): Promise<DeviceInfo[]>;
  executeTask(
    deviceId: string,
    task: string,
    timeoutMs?: number,
    guidance?: string,
    sessionId?: string,
    maxSteps?: number,
    allowedActions?: string[],
    allowedApps?: string[],
    taskPolicy?: TaskPolicy,
  ): Promise<TaskResult>;
  executeTaskAll(task: string, timeoutMs?: number): Promise<Record<string, TaskResult>>;
  executeBatch(tasks: Array<{ deviceId: string; task: string }>, timeoutMs?: number): Promise<Record<string, TaskResult>>;
  /**
   * Fan out and wait, but never past the soft deadline; whatever is still
   * running comes back as a live jobId instead of holding the caller open.
   */
  executeBatchBounded(
    tasks: Array<{ deviceId: string; task: string; maxSteps?: number }>,
    timeoutMs?: number,
    softDeadlineMs?: number,
  ): Promise<{
    jobId: string;
    done: boolean;
    results: Record<string, TaskResult>;
    pending: string[];
  }>;
  /** Fan out without waiting; the caller collects via {@link DeviceBridge.getJobStatus}. */
  dispatchTasks(
    tasks: Array<{ deviceId: string; task: string; maxSteps?: number }>,
    timeoutMs?: number,
  ): Promise<{ jobId: string; deviceCount: number }>;
  getJobStatus(
    jobId: string,
    opts?: { includeResults?: boolean; offset?: number; limit?: number },
  ): Promise<unknown>;
  cancelJob(jobId: string): Promise<{ cancelled: number; failed: Array<{ deviceId: string; error: string }> }>;
  getTaskResults(query: TaskResultQuery): Promise<CachedTaskResult[]>;
  cancelTask(deviceId: string, taskId: string): Promise<void>;
  executeSubTask(deviceId: string, params: SubTaskExecuteParams, timeoutMs?: number): Promise<SubTaskResult>;
  resumeOrchestration(deviceId: string, params: ResumeParams): Promise<OrchestrationResult>;
  getStatus(deviceId: string): Promise<DeviceInfo | null>;
  sendTaskStart(deviceId: string, params: TaskStartParams): Promise<void>;
  sendTaskEnd(deviceId: string, params: TaskEndParams): Promise<void>;
}

export const PluginConfigSchema = z.object({
  wsPort: z.number().int().min(1024).max(65535).default(18790),
  authTokenLifetime: z.number().int().positive().default(86400),
  maxDevices: z.number().int().positive().default(3),
});
export type PluginConfig = z.infer<typeof PluginConfigSchema>;
