import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { assert } from "./contracts.js";
export class TransactionVault {
  constructor(private key: Buffer) {
    assert(key.length === 32, "invalid_transaction_encryption_key");
  }
  seal(raw: string, context: string) {
    const iv = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(context));
    return Buffer.concat([
      iv,
      cipher.update(raw, "utf8"),
      cipher.final(),
      cipher.getAuthTag(),
    ]).toString("base64");
  }
  open(value: string, context: string) {
    const bytes = Buffer.from(value, "base64"),
      decipher = createDecipheriv(
        "aes-256-gcm",
        this.key,
        bytes.subarray(0, 12),
      );
    decipher.setAAD(Buffer.from(context));
    decipher.setAuthTag(bytes.subarray(-16));
    return Buffer.concat([
      decipher.update(bytes.subarray(12, -16)),
      decipher.final(),
    ]).toString("utf8");
  }
}
