import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

const ALG = "aes-256-gcm" as const;

function getKey(): Buffer {
  const hex = process.env.PLAID_ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error(
      "PLAID_ENCRYPTION_KEY must be set to exactly 64 hex characters. " +
        "Generate one with: openssl rand -hex 32",
    );
  }
  return Buffer.from(hex, "hex");
}

export interface EncryptedToken {
  enc: string; // hex-encoded ciphertext
  iv: string;  // hex-encoded 12-byte IV
  tag: string; // hex-encoded 16-byte GCM auth tag
}

export function encryptToken(plaintext: string): EncryptedToken {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALG, getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    enc: encrypted.toString("hex"),
    iv: iv.toString("hex"),
    tag: cipher.getAuthTag().toString("hex"),
  };
}

export function decryptToken(enc: string, iv: string, tag: string): string {
  const decipher = createDecipheriv(ALG, getKey(), Buffer.from(iv, "hex"));
  decipher.setAuthTag(Buffer.from(tag, "hex"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(enc, "hex")),
    decipher.final(),
  ]);
  return decrypted.toString("utf8");
}
