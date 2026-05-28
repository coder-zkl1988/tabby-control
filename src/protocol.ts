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
});
export type DeviceCapabilities = z.infer<typeof DeviceCapabilitiesSchema>;

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
]);
export type Channel = z.infer<typeof ChannelSchema>;

// ─── Task Channel ────────────────────────────────────────────────────────────

export const ExecuteParamsSchema = z.object({
  taskId: TaskIdSchema,
  task: z.string().min(1),
  mode: z.enum(['autonomous']).default('autonomous'),
  maxSteps: z.number().int().positive().optional(),
  guidance: z.string().optional(),
  sessionId: z.string().optional(),
  allowedActions: z.array(z.string()).optional(),
  allowedApps: z.array(z.string()).optional(),
});
export type ExecuteParams = z.infer<typeof ExecuteParamsSchema>;

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
  message: z.string().optional(),
  totalSteps: z.number().int().min(0).optional(),
  steps: z.array(StepRecordSchema).optional(),
  failedAtStep: z.number().int().min(1).optional(),
  finalScreenshot: z.string().optional(), // base64 PNG or file path
  duration: z.number().int().nonnegative().optional(), // ms
  needsInteraction: z.boolean().optional(),
  interactionMessage: z.string().optional(),
  interactionScreenshot: z.string().optional(), // file path
});
export type TaskResult = z.infer<typeof TaskResultSchema>;

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

const RpcRequestSchema = z.object({
  channel: ChannelSchema,
  id: z.string().optional(),
  method: z.string().optional(),
  params: z.record(z.string(), z.unknown()).optional(),
});
export type RpcRequest = z.infer<typeof RpcRequestSchema>;

const RpcResponseSchema = z.object({
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
  executeTask(deviceId: string, task: string, timeoutMs?: number, guidance?: string, sessionId?: string, maxSteps?: number, allowedActions?: string[], allowedApps?: string[]): Promise<TaskResult>;
  executeTaskAll(task: string, timeoutMs?: number): Promise<Record<string, TaskResult>>;
  executeBatch(tasks: Array<{ deviceId: string; task: string }>, timeoutMs?: number): Promise<Record<string, TaskResult>>;
  cancelTask(deviceId: string, taskId: string): Promise<void>;
  executeSubTask(deviceId: string, params: SubTaskExecuteParams, timeoutMs?: number): Promise<SubTaskResult>;
  resumeOrchestration(deviceId: string, params: ResumeParams): Promise<OrchestrationResult>;
  getStatus(deviceId: string): Promise<DeviceInfo | null>;
  sendTaskStart(deviceId: string, params: TaskStartParams): Promise<void>;
  sendTaskEnd(deviceId: string, params: TaskEndParams): Promise<void>;
}

// ─── MQTT Topics ──────────────────────────────────────────────────────────────

export const MQTT_TOPIC_PREFIX = 'phone';

export function mqttTopic(deviceId: string, suffix: string): string {
  return `${MQTT_TOPIC_PREFIX}/${deviceId}/${suffix}`;
}

export const MQTT_SUFFIXES = {
  HELLO: 'hello',
  TASK: 'task',
  CANCEL: 'cancel',
  STATUS: 'status',
  FRAME: 'frame',
  PROGRESS: 'progress',
  RESULT: 'result',
  LOG: 'log',
  MIRROR_CMD: 'mirror_cmd',
} as const;

// ─── MQTT Frame (binary+JSON header) ─────────────────────────────────────────

export const FrameHeaderSchema = z.object({
  seq: z.number().int().nonnegative(),
  ts: z.number().int().positive(),
  w: z.number().int().positive(),
  h: z.number().int().positive(),
  app: z.string().optional(),
  status: z.enum(['idle', 'busy', 'error']).default('idle'),
  fmt: z.enum(['jpeg', 'webp']).default('jpeg'),
  len: z.number().int().positive(),
});
export type FrameHeader = z.infer<typeof FrameHeaderSchema>;

/** Separator between JSON header and binary data in MQTT frame messages */
export const FRAME_HEADER_SEPARATOR = '\n';

// ─── MQTT Config ─────────────────────────────────────────────────────────────

export const MqttConfigSchema = z.object({
  mqttPort: z.number().int().min(1024).max(65535).default(18883),
});

export const PluginConfigSchema = z.object({
  wsPort: z.number().int().min(1024).max(65535).default(18790),
  authTokenLifetime: z.number().int().positive().default(86400),
  maxDevices: z.number().int().positive().default(3),
}).merge(MqttConfigSchema);
export type PluginConfig = z.infer<typeof PluginConfigSchema>;
