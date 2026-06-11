import { Pool } from "pg";
import { LlmEvaluationRecord, LlmEvaluationRepository, LlmEvaluationRequest } from "../application/llm-evaluation";

export class PostgresLlmEvaluationRepository implements LlmEvaluationRepository {
  constructor(private readonly pool: Pool) {}

  async findCached(request: LlmEvaluationRequest, inputHash: string): Promise<LlmEvaluationRecord | undefined> {
    const result = await this.pool.query<LlmEvaluationRow>(
      `select id, task_type, prompt_version, input_hash, model, input, output, parsed_output, status,
              prompt_tokens, completion_tokens, estimated_cost_usd, latency_ms, payload_schema_version, created_at
       from llm_evaluations
       where task_type = $1
         and prompt_version = $2
         and model = $3
         and input_hash = $4
         and status = 'succeeded'
       limit 1`,
      [request.taskType, request.promptVersion, request.model, inputHash]
    );

    const row = result.rows[0];
    return row ? toRecord(row) : undefined;
  }

  async save(record: LlmEvaluationRecord): Promise<void> {
    await this.pool.query(
      `insert into llm_evaluations (
        id, task_type, prompt_version, input_hash, model, input, output, parsed_output, status,
        prompt_tokens, completion_tokens, estimated_cost_usd, latency_ms, payload_schema_version, created_at
      ) values ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9, $10, $11, $12, $13, $14, $15)
      on conflict (task_type, input_hash, prompt_version, model) do update set
        id = excluded.id,
        input = excluded.input,
        output = excluded.output,
        parsed_output = excluded.parsed_output,
        status = excluded.status,
        prompt_tokens = excluded.prompt_tokens,
        completion_tokens = excluded.completion_tokens,
        estimated_cost_usd = excluded.estimated_cost_usd,
        latency_ms = excluded.latency_ms,
        payload_schema_version = excluded.payload_schema_version,
        created_at = excluded.created_at`,
      [
        record.id,
        record.taskType,
        record.promptVersion,
        record.inputHash,
        record.model,
        JSON.stringify(record.input),
        record.output ? JSON.stringify(record.output) : null,
        record.parsedOutput ? JSON.stringify(record.parsedOutput) : null,
        record.status,
        record.promptTokens,
        record.completionTokens,
        record.estimatedCostUsd,
        record.latencyMs,
        record.payloadSchemaVersion ?? null,
        record.createdAt
      ]
    );
  }
}

interface LlmEvaluationRow {
  id: string;
  task_type: LlmEvaluationRecord["taskType"];
  prompt_version: string;
  input_hash: string;
  model: string;
  input: Record<string, unknown>;
  output: Record<string, unknown> | null;
  parsed_output: Record<string, unknown> | null;
  status: LlmEvaluationRecord["status"];
  prompt_tokens: number | null;
  completion_tokens: number | null;
  estimated_cost_usd: string | number | null;
  latency_ms: number | null;
  payload_schema_version: string | null;
  created_at: Date | string;
}

function toRecord(row: LlmEvaluationRow): LlmEvaluationRecord {
  return {
    id: row.id,
    taskType: row.task_type,
    promptVersion: row.prompt_version,
    inputHash: row.input_hash,
    model: row.model,
    input: row.input,
    output: row.output ?? undefined,
    parsedOutput: row.parsed_output ?? undefined,
    status: row.status,
    promptTokens: row.prompt_tokens ?? 0,
    completionTokens: row.completion_tokens ?? 0,
    estimatedCostUsd: Number(row.estimated_cost_usd ?? 0),
    latencyMs: row.latency_ms ?? 0,
    payloadSchemaVersion: row.payload_schema_version ?? undefined,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at
  };
}
