-- Phase 5: Add human-review workflow columns to opportunities table
alter table opportunities
  add column if not exists human_review_flag text,
  add column if not exists human_review_notes text;
