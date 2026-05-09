/**
 * tabby-control protocol
 *
 * All shared types and Zod schemas for the device control plugin.
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
  screenshot: z.string(), // base64 PNG
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

// ─── Config ─────────────────────────────────────────────────────────────────

export const PluginConfigSchema = z.object({
  wsPort: z.number().int().min(1024).max(65535).default(18790),
  authTokenLifetime: z.number().int().positive().default(86400),
  maxDevices: z.number().int().positive().default(3),
});
export type PluginConfig = z.infer<typeof PluginConfigSchema>;

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
  getStatus(deviceId: string): Promise<DeviceInfo | null>;
}
