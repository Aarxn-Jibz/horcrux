import { encodeBase64Url } from "../packages/protocol/src";

const keys = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
const privateKey = encodeBase64Url(new Uint8Array(await crypto.subtle.exportKey("pkcs8", keys.privateKey)));
const publicKey = encodeBase64Url(new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey)));

console.log(`CAPABILITY_PRIVATE_KEY=${privateKey}`);
console.log(`CAPABILITY_PUBLIC_KEY=${publicKey}`);
