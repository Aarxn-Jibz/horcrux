export const FILE_STATUS = ["uploading", "available", "failed", "deleted"] as const;
export type FileStatus = typeof FILE_STATUS[number];

