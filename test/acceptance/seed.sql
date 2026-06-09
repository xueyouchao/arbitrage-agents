begin;

truncate table alerts, opportunities, orderbook_snapshots, candidate_pairs, venue_market_snapshots, normalized_markets, scan_runs, llm_evaluations restart identity cascade;

insert into scan_runs (id, status, started_at, completed_at, metrics)
values (
  '00000000-0000-4000-8000-000000000001',
  'succeeded',
  '2026-06-03T11:59:59.000Z',
  '2026-06-03T12:00:01.000Z',
  '{"marketsScanned":2,"normalizedMarkets":2,"candidatePairs":1,"opportunitiesFound":1,"llmEvaluations":0}'::jsonb
);

insert into normalized_markets (
  id,
  venue,
  venue_market_id,
  title,
  raw_resolution_text,
  topic,
  event_type,
  asset,
  threshold,
  operator,
  deadline,
  timezone,
  resolution_source,
  payoff_type,
  ambiguity_flags,
  confidence,
  created_at
)
values
  (
    '00000000-0000-4000-8000-000000000101',
    'kalshi',
    'K1',
    'Will Bitcoin be above $100,000 on Jan 1, 2026?',
    'Resolves using Coinbase BTC/USD at 2026-01-01T00:00:00Z',
    'crypto',
    'price_above',
    'BTC',
    100000,
    '>',
    '2026-01-01T00:00:00.000Z',
    'UTC',
    'Coinbase BTC/USD',
    'at_time',
    '[]'::jsonb,
    0.95,
    '2026-06-03T12:00:00.000Z'
  ),
  (
    '00000000-0000-4000-8000-000000000102',
    'polymarket',
    'P1',
    'Will BTC be above $100,000 on Jan 1, 2026?',
    'Resolves using Coinbase BTC/USD at 2026-01-01T00:00:00Z',
    'crypto',
    'price_above',
    'BTC',
    100000,
    '>',
    '2026-01-01T00:00:00.000Z',
    'UTC',
    'Coinbase BTC/USD',
    'at_time',
    '[]'::jsonb,
    0.93,
    '2026-06-03T12:00:01.000Z'
  );

insert into candidate_pairs (id, kalshi_market_id, polymarket_market_id, equivalence_class, decision, reasons, created_at)
values (
  '00000000-0000-4000-8000-000000000201',
  '00000000-0000-4000-8000-000000000101',
  '00000000-0000-4000-8000-000000000102',
  'A',
  'tradable',
  '["same asset", "same threshold", "same deadline"]'::jsonb,
  '2026-06-03T12:00:02.000Z'
);

insert into orderbook_snapshots (
  id,
  scan_run_id,
  normalized_market_id,
  yes_ask,
  no_ask,
  yes_available_usd,
  no_available_usd,
  raw_payload,
  captured_at,
  stale
)
values
  (
    '00000000-0000-4000-8000-000000000301',
    '00000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-000000000101',
    0.42,
    0.62,
    20,
    30,
    '{"marketId":"K1","venue":"kalshi"}'::jsonb,
    '2026-06-03T12:00:00.000Z',
    false
  ),
  (
    '00000000-0000-4000-8000-000000000302',
    '00000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-000000000102',
    0.50,
    0.51,
    50,
    12,
    '{"marketId":"P1","venue":"polymarket"}'::jsonb,
    '2026-06-03T12:00:00.000Z',
    false
  );

insert into opportunities (
  id,
  candidate_pair_id,
  kalshi_orderbook_snapshot_id,
  polymarket_orderbook_snapshot_id,
  long_leg,
  hedge_leg,
  combined_cost,
  gross_edge,
  estimated_fees,
  estimated_slippage,
  net_edge,
  max_tradable_usd,
  equivalence_class,
  resolution_risk,
  fill_risk,
  detected_at,
  last_verified_at
)
values (
  '00000000-0000-4000-8000-000000000401',
  '00000000-0000-4000-8000-000000000201',
  '00000000-0000-4000-8000-000000000301',
  '00000000-0000-4000-8000-000000000302',
  '{"venue":"kalshi","marketId":"K1","side":"YES","askPrice":0.42,"availableUsd":20}'::jsonb,
  '{"venue":"polymarket","marketId":"P1","side":"NO","askPrice":0.51,"availableUsd":12}'::jsonb,
  0.93,
  0.07,
  0.01,
  0.005,
  0.055,
  12,
  'A',
  'low',
  'medium',
  '2026-06-03T12:00:01.000Z',
  '2026-06-03T12:00:01.000Z'
);

commit;
