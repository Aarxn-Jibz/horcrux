export interface Env {
  DB: D1Database;
  JWT_SECRET: string;
  AUTH_PEPPER?: string;
  WEB_ORIGIN: string;
  CAPABILITY_PRIVATE_KEY?: string;
  CAPABILITY_PUBLIC_KEY?: string;
  TURN_KEY_ID?: string;
  TURN_API_TOKEN?: string;
  TURN_CREDENTIALS_URL?: string;
}
