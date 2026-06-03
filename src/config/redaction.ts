const SENSITIVE_KEY_PATTERN = /(api[_-]?key|private[_-]?key|secret|token|password|authorization|auth[_-]?header|wallet|dsn|database[_-]?url|email|pii)/i;
const SENSITIVE_VALUE_PATTERN = /(postgres(?:ql)?:\/\/[^\s]+|bearer\s+[A-Za-z0-9._~+\/-]+|api[_-]?key[=:]\s*[^\s,;]+|token[=:]\s*[^\s,;]+|password[=:]\s*[^\s,;]+)/gi;
const REDACTED = "[REDACTED]";

export function redactSensitiveData<T>(value: T): T {
  return redactValue(value) as T;
}

export function redactSensitiveText(value: string): string {
  return value.replace(SENSITIVE_VALUE_PATTERN, REDACTED);
}

function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, child]) => [
        key,
        SENSITIVE_KEY_PATTERN.test(key) ? REDACTED : redactValue(child)
      ])
    );
  }

  if (typeof value === "string") {
    return redactSensitiveText(value);
  }

  return value;
}
