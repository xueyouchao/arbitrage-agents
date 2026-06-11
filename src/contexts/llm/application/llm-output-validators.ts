import { ZodType } from "zod";
import { LlmEvaluationRequest } from "./llm-evaluation";

/**
 * Single source of truth for LLM task output schemas. Centralising
 * validator registration here (a) prevents the prompt-side
 * `schemaInstructionFor` and the validator-side `schemaForTask` from
 * drifting (issue #15), and (b) lets scanner-specific task types register
 * their schemas next to the scanner domain contract rather than inside the
 * generic LLM persistence module (issue #14).
 */
export class LlmOutputValidatorRegistry {
  private readonly validators = new Map<string, { version: string; schema: ZodType<Record<string, unknown>> }>();

  register(taskType: LlmEvaluationRequest["taskType"], version: string, schema: ZodType<Record<string, unknown>>): this {
    this.validators.set(taskType, { version, schema });
    return this;
  }

  schemaVersionFor(taskType: LlmEvaluationRequest["taskType"]): string {
    return this.validators.get(taskType)?.version ?? "v0";
  }

  validate(taskType: LlmEvaluationRequest["taskType"], output: unknown): Record<string, unknown> | undefined {
    const entry = this.validators.get(taskType);
    if (!entry) return undefined;
    const parsed = entry.schema.safeParse(output);
    return parsed.success ? parsed.data : undefined;
  }
}
