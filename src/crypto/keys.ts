// Sealing a secret (a course owner's model API key) for storage: AES-256-GCM with a key derived by HKDF
// from the Worker secret KEY_ENCRYPTION_SECRET and bound to one course. Only the sealed form is stored;
// it can't be opened in another course or without the Worker secret. WebCrypto, so the same code runs in
// Workers and Node.

/** Shortest KEY_ENCRYPTION_SECRET accepted (e.g. `openssl rand -base64 32` gives 44 characters). */
export const MIN_SECRET_LENGTH = 32;

const FORMAT = "v1";
const SALT = new TextEncoder().encode("hyperlearn/model-key/v1");

/** Keys can't be sealed or opened: the Worker secret is missing or too short. */
export class KeysUnavailable extends Error {
  constructor() {
    super(`Model keys can't be stored: KEY_ENCRYPTION_SECRET isn't set on the Worker (at least ${MIN_SECRET_LENGTH} characters)`);
  }
}

export const keysAvailable = (secret: string | undefined): secret is string => typeof secret === "string" && secret.length >= MIN_SECRET_LENGTH;

const encode = (text: string) => new TextEncoder().encode(text);
const toBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text.replaceAll("-", "+").replaceAll("_", "/"));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

/** One AES key per (secret, context): a ciphertext from one course can't be opened as another's. */
async function keyFor(secret: string | undefined, context: string): Promise<CryptoKey> {
  if (!keysAvailable(secret)) throw new KeysUnavailable();
  const material = await crypto.subtle.importKey("raw", encode(secret), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: SALT, info: encode(context) },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** Seals `plaintext` for `context` (the course id): "v1.<iv>.<ciphertext>", base64url, a fresh random IV each time. */
export async function sealSecret(plaintext: string, secret: string | undefined, context: string): Promise<string> {
  const key = await keyFor(secret, context);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: encode(context) }, key, encode(plaintext));
  return [FORMAT, toBase64(iv), toBase64(new Uint8Array(sealed))].join(".");
}

/** Opens what sealSecret made for the same context. Throws on any change to it, or the wrong secret or context. */
export async function openSecret(sealed: string, secret: string | undefined, context: string): Promise<string> {
  const key = await keyFor(secret, context);
  const [format, iv, data] = sealed.split(".");
  if (format !== FORMAT || !iv || !data) throw new Error("Not a sealed key");
  try {
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64(iv), additionalData: encode(context) }, key, fromBase64(data));
    return new TextDecoder().decode(plain);
  } catch {
    // No detail: whatever went wrong, the stored key can't be used and has to be set again.
    throw new Error("The stored model key can't be opened; set it again");
  }
}
