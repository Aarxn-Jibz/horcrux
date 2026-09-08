const ITERATIONS = 310_000;
const encoder = new TextEncoder();
const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const decode = (value: string) => Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
const cryptoBytes = (bytes: Uint8Array) => bytes as Uint8Array<ArrayBuffer>;

async function derive(password: string, salt: Uint8Array, iterations: number) { const material = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]); return new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: cryptoBytes(salt), iterations }, material, 256)); }
export async function hashPassword(password: string) { const salt = crypto.getRandomValues(new Uint8Array(16)); const hash = await derive(password, salt, ITERATIONS); return `pbkdf2-sha256$${ITERATIONS}$${encode(salt)}$${encode(hash)}`; }
export async function verifyPassword(password: string, encoded: string) { const [algorithm, count, saltValue, expectedValue] = encoded.split("$"); if (algorithm !== "pbkdf2-sha256" || !count || !saltValue || !expectedValue) return false; const actual = await derive(password, decode(saltValue), Number(count)); const expected = decode(expectedValue); if (actual.length !== expected.length) return false; let difference = 0; for (let i = 0; i < actual.length; i++) difference |= actual[i]! ^ expected[i]!; return difference === 0; }

