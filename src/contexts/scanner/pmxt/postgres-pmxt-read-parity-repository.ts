import { Pool } from "pg";
import { PmxtReadParityBatch, PmxtReadParityRepository } from "./pmxt-read-parity";

// Issue #96: Dedicated shadow-only persistence. Writes only to
// pmxt_shadow_candidates, pmxt_shadow_opportunities, and
// pmxt_shadow_comparisons. Never touches production tables
// (candidate_pairs, opportunities, alerts, etc.).
export class PostgresPmxtReadParityRepository implements PmxtReadParityRepository {
  constructor(private readonly pool: Pool) {}

  async saveBatch(batch: PmxtReadParityBatch): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");

      const decisionByPairId = new Map(
        batch.candidateDecisions.map((d) => [d.pairId, d]),
      );

      for (const candidate of batch.candidates) {
        const decision = decisionByPairId.get(candidate.id);
        await client.query(
          `insert into pmxt_shadow_candidates (
            authoritative_scan_run_id, shadow_run_id, shadow_run_attempt_id,
            candidate_pair_id, kalshi_market_id, polymarket_market_id,
            equivalence_class, decision, reasons, payload
          ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb)
          on conflict (authoritative_scan_run_id, shadow_run_id, shadow_run_attempt_id, candidate_pair_id) do nothing`,
          [
            batch.authoritativeScanRunId,
            batch.shadowRunId,
            batch.shadowRunAttemptId,
            candidate.id,
            candidate.kalshiMarket.id,
            candidate.polymarketMarket.id,
            decision?.equivalenceClass ?? null,
            decision?.decision ?? null,
            JSON.stringify(candidate.reasons),
            JSON.stringify(candidate),
          ],
        );
      }

      for (const opportunity of batch.opportunities) {
        await client.query(
          `insert into pmxt_shadow_opportunities (
            authoritative_scan_run_id, shadow_run_id, shadow_run_attempt_id,
            opportunity_id, candidate_pair_id, payload
          ) values ($1, $2, $3, $4, $5, $6::jsonb)
          on conflict (authoritative_scan_run_id, shadow_run_id, shadow_run_attempt_id, opportunity_id) do nothing`,
          [
            batch.authoritativeScanRunId,
            batch.shadowRunId,
            batch.shadowRunAttemptId,
            opportunity.id,
            opportunity.pairId,
            JSON.stringify(opportunity),
          ],
        );
      }

      for (const comparison of batch.comparisons) {
        await client.query(
          `insert into pmxt_shadow_comparisons (
            authoritative_scan_run_id, shadow_run_id, shadow_run_attempt_id,
            stage, outcome, cause, authoritative, shadow, provenance
          ) values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb)
          on conflict (authoritative_scan_run_id, shadow_run_id, shadow_run_attempt_id, stage) do nothing`,
          [
            batch.authoritativeScanRunId,
            batch.shadowRunId,
            batch.shadowRunAttemptId,
            comparison.stage,
            comparison.outcome,
            comparison.cause,
            JSON.stringify(comparison.authoritative),
            JSON.stringify(comparison.shadow),
            JSON.stringify(comparison.provenance),
          ],
        );
      }

      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }
}
