export interface Env {
  DB: D1Database;
  JWT_SECRET: string;
  WEB_ORIGIN: string;
  CAPABILITY_PRIVATE_KEY?: string;
  CAPABILITY_PUBLIC_KEY?: string;
}
