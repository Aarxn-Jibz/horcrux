import { expect, test } from "bun:test";
import { deriveCredential, freshKdf, validKdf } from "./auth-credential";

test("browser derives credentials without persistence", async () => {
  const kdf = freshKdf(); const first = await deriveCredential("password-123", kdf); const second = await deriveCredential("password-123", kdf);
  expect(first).toBe(second); expect(first).not.toBe("password-123"); expect("localStorage" in globalThis).toBeFalse();
});

test("rejects unsupported challenge KDF metadata before crypto", async () => {
  const kdf = freshKdf();
  for (const invalid of [{ ...kdf, version: "v2" }, { ...kdf, algorithm: "scrypt" }, { ...kdf, hash: "SHA-1" }, { ...kdf, iterations: 1 }, { ...kdf, iterations: 9_999_999 }, { ...kdf, salt: "bad" }, { ...kdf, salt: "AAAAAAAAAAAAAAAAAAAAAA=A" }, { ...kdf, derivedKeyLength: 128 }]) { expect(validKdf(invalid)).toBeFalse(); await expect(deriveCredential("password", invalid)).rejects.toThrow("Unsupported authentication KDF parameters"); }
});
