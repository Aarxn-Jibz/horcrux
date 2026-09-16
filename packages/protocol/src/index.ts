import { z } from "zod";
export * from "./envelope";

export const PROTOCOL_VERSION = "1" as const;
export const objectOperationSchema = z.enum(["PUT", "GET", "DELETE"]);
export type ObjectOperation = z.infer<typeof objectOperationSchema>;

const identifier = z.string().min(1).max(256);
const checksum = z.string().regex(/^[a-f0-9]{64}$/);

export const storageCapabilitySchema = z.object({
  version: z.literal(PROTOCOL_VERSION),
  issuer: z.string().min(1).max(128),
  nodeId: identifier,
  objectId: identifier,
  operation: objectOperationSchema,
  issuedAt: z.int().nonnegative(),
  expiresAt: z.int().positive(),
  jti: z.uuid(),
  checksum: checksum.optional(),
  size: z.int().nonnegative().optional(),
  /** A streamed PUT is bounded but its final metadata is node-attested. */
  maxSize: z.int().positive().optional(),
}).refine((value) => value.expiresAt > value.issuedAt, "capability must expire after issuance")
  .refine((value) => value.operation !== "PUT" || (value.maxSize !== undefined || (value.checksum !== undefined && value.size !== undefined)), "PUT requires exact metadata or a maximum size")
  .refine((value) => value.maxSize === undefined || (value.checksum === undefined && value.size === undefined), "streamed PUT metadata is node-attested");
export type StorageCapability = z.infer<typeof storageCapabilitySchema>;

export const storageReceiptSchema = z.object({
  version: z.literal(PROTOCOL_VERSION),
  nodeId: identifier,
  objectId: identifier,
  checksum,
  size: z.int().nonnegative(),
  timestamp: z.int().nonnegative(),
  requestId: z.string().min(16).max(128),
});
export type StorageReceipt = z.infer<typeof storageReceiptSchema>;

export const heartbeatSchema = z.object({
  version: z.literal(PROTOCOL_VERSION),
  nodeId: identifier,
  status: z.enum(["online", "degraded"]),
  capacityBytes: z.int().nonnegative(),
  usedBytes: z.int().nonnegative(),
  availableBytes: z.int().nonnegative(),
  nodeVersion: z.string().min(1).max(64),
  endpoint: z.string().url().max(512),
  timestamp: z.int().nonnegative(),
  features: z.array(z.literal("deletion-tasks-v1")).max(8).optional(),
  deletionResults: z.array(z.object({
    taskId: z.uuid(),
    objectId: identifier,
    status: z.enum(["deleted", "failed"]),
    error: z.string().min(1).max(256).optional(),
  })).max(32).optional(),
});
export type NodeHeartbeat = z.infer<typeof heartbeatSchema>;

export const enrollmentChallengeSchema = z.object({
  challengeId: z.uuid(),
  token: z.string().min(32).max(512),
  expiresAt: z.iso.datetime(),
});

export const enrollmentProofSchema = z.object({
  challengeId: z.uuid(),
  token: z.string().min(32).max(512),
  publicKey: z.string().min(40).max(128),
  signature: z.string().min(40).max(128),
  name: z.string().min(1).max(128),
  capacityBytes: z.int().nonnegative(),
});

/** Opaque SDP/ICE relay records; the Worker never interprets peer bytes. */
export const webRtcSignalSchema = z.object({
  sessionId: z.uuid(),
  nodeId: identifier,
  sender: z.enum(["browser", "node"]),
  type: z.enum(["offer", "answer", "ice-candidate"]),
  payload: z.string().min(1).max(128 * 1024),
});
export type WebRtcSignal = z.infer<typeof webRtcSignalSchema>;

export const webRtcNodeAuthSchema = z.object({ version: z.literal(PROTOCOL_VERSION), nodeId: identifier, timestamp: z.int().nonnegative() });
