import { expect, test } from "bun:test";
import { deriveCredential, freshKdf } from "./auth-credential";

test("browser derives credentials without persistence", async () => {
  const kdf = freshKdf(); const first = await deriveCredential("password-123", kdf); const second = await deriveCredential("password-123", kdf);
  expect(first).toBe(second); expect(first).not.toBe("password-123"); expect("localStorage" in globalThis).toBeFalse();
});
