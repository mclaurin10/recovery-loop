import { createHash } from "node:crypto";
import type { CommandClassification } from "./contracts.js";

interface SensitivePattern {
  label: string;
  expression: RegExp;
}

const SENSITIVE_PATTERNS: readonly SensitivePattern[] = [
  {
    label: "private-key",
    expression:
      /-----BEGIN (?:(?:RSA|EC|DSA|OPENSSH|ENCRYPTED) )?PRIVATE KEY-----[\s\S]*?-----END (?:(?:RSA|EC|DSA|OPENSSH|ENCRYPTED) )?PRIVATE KEY-----/giu,
  },
  {
    label: "private-key",
    expression: /-----BEGIN PGP PRIVATE KEY BLOCK-----[\s\S]*?-----END PGP PRIVATE KEY BLOCK-----/giu,
  },
  { label: "aws-access-key", expression: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/gu },
  { label: "github-token", expression: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,255}\b/gu },
  { label: "github-token", expression: /\bgithub_pat_[A-Za-z0-9_]{40,255}\b/gu },
  { label: "gitlab-token", expression: /\bglpat-[A-Za-z0-9_-]{20,255}\b/gu },
  { label: "slack-token", expression: /\bxox[baprs]-[A-Za-z0-9-]{20,255}\b/gu },
  { label: "stripe-live-key", expression: /\b[rs]k_live_[A-Za-z0-9]{20,255}\b/gu },
  { label: "openai-key", expression: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,255}\b/gu },
  {
    label: "credential-url",
    expression: /\b(?:https?|postgres(?:ql)?|mysql):\/\/[^\s/:@]{1,128}:[^\s/@]{8,256}@/giu,
  },
];

export interface SensitiveMatch {
  label: string;
  excerpt: string;
}

export function findSensitiveMaterial(text: string): SensitiveMatch[] {
  const matches: SensitiveMatch[] = [];
  for (const pattern of SENSITIVE_PATTERNS) {
    for (const match of text.matchAll(pattern.expression)) {
      const value = match[0];
      if (value === undefined) continue;
      matches.push({
        label: pattern.label,
        excerpt: value.slice(0, Math.min(value.length, 20)),
      });
    }
  }
  return matches;
}

export function redact(text: string, additionalSecrets: readonly string[] = []): string {
  let redacted = text;
  for (const pattern of SENSITIVE_PATTERNS) {
    redacted = redacted.replace(pattern.expression, `[REDACTED ${pattern.label.toUpperCase()}]`);
  }
  for (const secret of additionalSecrets) {
    if (secret.length < 4) continue;
    redacted = redacted.replaceAll(secret, "[REDACTED]");
  }
  return redacted;
}

export class ByteTail {
  readonly maximumBytes: number;
  #buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);

  constructor(maximumBytes: number) {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0) {
      throw new Error("tail size must be a positive integer");
    }
    this.maximumBytes = maximumBytes;
  }

  append(chunk: Buffer | string): void {
    const incoming = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    if (incoming.length >= this.maximumBytes) {
      this.#buffer = incoming.subarray(incoming.length - this.maximumBytes);
      return;
    }
    const combined = Buffer.concat([this.#buffer, incoming]);
    this.#buffer =
      combined.length > this.maximumBytes
        ? combined.subarray(combined.length - this.maximumBytes)
        : combined;
  }

  text(): string {
    return this.#buffer.toString("utf8");
  }
}

export function boundedRedactedTail(
  tail: ByteTail,
  additionalSecrets: readonly string[] = [],
): string {
  return redact(tail.text(), additionalSecrets);
}

export function normalizeDiagnostic(text: string, variablePaths: readonly string[] = []): string {
  let normalized = redact(text);
  for (const variablePath of [...variablePaths].sort((a, b) => b.length - a.length)) {
    if (variablePath.length > 0) normalized = normalized.replaceAll(variablePath, "<PATH>");
  }
  return normalized
    .replaceAll(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/gu, "<TIME>")
    .replaceAll(/\b(?:pid|process)[=:# ]+\d+\b/giu, "pid=<PID>")
    .replaceAll(/(?:[A-Za-z]:[\\/]|\/)(?:[^\s:'"]+[\\/])*(?:tmp|temp)[\\/][^\s:'"]+/giu, "<TEMP_PATH>")
    .replaceAll(/\s+/gu, " ")
    .trim();
}

export function commandSignature(input: {
  checkId: string;
  classification: CommandClassification;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdoutTail: string;
  stderrTail: string;
  variablePaths?: readonly string[];
}): string {
  const normalized = JSON.stringify({
    checkId: input.checkId,
    classification: input.classification,
    exitCode: input.exitCode,
    signal: input.signal,
    stdout: normalizeDiagnostic(input.stdoutTail, input.variablePaths),
    stderr: normalizeDiagnostic(input.stderrTail, input.variablePaths),
  });
  return createHash("sha256").update(normalized).digest("hex");
}
