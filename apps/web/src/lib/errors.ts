export interface DisplayError {
  message: string;
  detail?: string;
}

const messages: Array<[RegExp, string]> = [
  [/storage node .*unavailable|connection.*failed/i, "A storage device is unavailable. Check Devices and try again."],
  [/webrtc answer timed out|signal.*session|signaling/i, "WebRTC signaling did not reach the device. Check that it is online, then retry."],
  [/ice .*timed out|data channel|shard stream stalled/i, "The direct WebRTC connection was interrupted. Check the device's network connection, then retry."],
  [/insufficient reed-solomon shards/i, "Not enough healthy devices are reachable to reconstruct this file."],
  [/insufficient shamir shares/i, "Not enough key shares are available to unlock this file."],
  [/integrity verification|checksum|corrupt/i, "Integrity verification failed. One or more stored objects may be corrupt."],
  [/decryption failed/i, "Encrypted data authentication failed. The file cannot be safely opened."],
  [/expired|invalid token|authorization/i, "Device authorization expired. Please retry the operation."],
  [/out of space|insufficient storage/i, "A storage device does not have enough available space."],
  [/no storage nodes/i, "No healthy storage devices are currently available."],
];

export function describeError(cause: unknown, fallback: string): DisplayError {
  const detail = cause instanceof Error ? cause.message : fallback;
  const match = messages.find(([pattern]) => pattern.test(detail));
  return { message: match?.[1] ?? detail, ...(match && match[1] !== detail ? { detail } : {}) };
}
