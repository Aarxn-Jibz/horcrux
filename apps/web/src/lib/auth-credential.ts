export type Kdf = { version: "pbkdf2-sha256-v1"; iterations: 310000; salt: string };
const encoder = new TextEncoder();
const bytes = (value: string) => Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
const encode = (value: Uint8Array) => btoa(String.fromCharCode(...value));
export function freshKdf(): Kdf { return { version: "pbkdf2-sha256-v1", iterations: 310000, salt: encode(crypto.getRandomValues(new Uint8Array(16))) }; }
export async function deriveCredential(password: string, kdf: Kdf) { const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]); return encode(new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: bytes(kdf.salt), iterations: kdf.iterations }, key, 256))); }
