const encoder = new TextEncoder();
export const KDF_VERSION = "pbkdf2-sha256-v1";
export const KDF_ITERATIONS = 310_000;
export type Kdf = { version: string; iterations: number; salt: string };
const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
export function freshKdf(): Kdf { return { version: KDF_VERSION, iterations: KDF_ITERATIONS, salt: encode(crypto.getRandomValues(new Uint8Array(16))) }; }
export function validKdf(value: unknown): value is Kdf { return !!value && typeof value === "object" && (value as Kdf).version === KDF_VERSION && (value as Kdf).iterations === KDF_ITERATIONS && typeof (value as Kdf).salt === "string" && /^[A-Za-z0-9+/]{22}==$/.test((value as Kdf).salt); }
export async function verifier(credential: string, pepper?: string) { if (!pepper) throw new Error("AUTH_PEPPER is not configured"); const key = await crypto.subtle.importKey("raw", encoder.encode(pepper), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]); return encode(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(credential)))); }
export function equal(left: string, right: string) { if (left.length !== right.length) return false; let difference = 0; for (let i = 0; i < left.length; i++) difference |= left.charCodeAt(i) ^ right.charCodeAt(i); return difference === 0; }
