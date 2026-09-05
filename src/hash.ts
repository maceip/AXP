import { createHash, sign, verify, createPublicKey } from "node:crypto";
import type { Signature } from "./protocol/types.js";

/** Sorted JSON objects, preserved array order, no undefined/non-finite values. */
export function canonical(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value))
    return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(object[k])}`)
      .join(",")}}`;
  }
  throw new TypeError("Canonical JSON requires JSON values");
}
export function hash(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
export function hashObject(value: unknown): string {
  return hash(canonical(value));
}
export function signObject(value: unknown, privateKey: string): Signature {
  const publicKey = createPublicKey(privateKey)
    .export({ type: "spki", format: "pem" })
    .toString();
  return {
    publicKey,
    signature: sign(null, Buffer.from(canonical(value)), privateKey).toString(
      "base64",
    ),
  };
}
export function verifyObject(value: unknown, signed: Signature): boolean {
  try {
    const key = createPublicKey(signed.publicKey);
    return (
      key.asymmetricKeyType === "ed25519" &&
      verify(
        null,
        Buffer.from(canonical(value)),
        key,
        Buffer.from(signed.signature, "base64"),
      )
    );
  } catch {
    return false;
  }
}
