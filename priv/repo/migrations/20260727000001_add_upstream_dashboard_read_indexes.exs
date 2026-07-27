defmodule CodexPooler.Repo.Migrations.AddUpstreamDashboardReadIndexes do
  use Ecto.Migration

  @disable_ddl_transaction true
  @disable_migration_lock true

  def up do
    execute("""
    CREATE INDEX CONCURRENTLY IF NOT EXISTS attempts_upstream_identity_started_idx
    ON attempts (upstream_identity_id, started_at DESC)
    WHERE upstream_identity_id IS NOT NULL
    """)

    execute("""
    CREATE INDEX CONCURRENTLY IF NOT EXISTS ledger_entries_identity_settlement_occurred_idx
    ON ledger_entries (upstream_identity_id, occurred_at DESC)
    WHERE upstream_identity_id IS NOT NULL
      AND entry_kind = 'settlement'
      AND amount_status = 'recorded'
    """)

    execute("""
    CREATE INDEX CONCURRENTLY IF NOT EXISTS oban_jobs_token_refresh_identity_recent_idx
    ON oban_jobs (
      worker,
      (args->>'upstream_identity_id'),
      (COALESCE(attempted_at, scheduled_at, inserted_at)) DESC
    )
    WHERE args ? 'upstream_identity_id'
    """)
  end

  def down do
    execute("DROP INDEX CONCURRENTLY IF EXISTS oban_jobs_token_refresh_identity_recent_idx")
    execute("DROP INDEX CONCURRENTLY IF EXISTS ledger_entries_identity_settlement_occurred_idx")
    execute("DROP INDEX CONCURRENTLY IF EXISTS attempts_upstream_identity_started_idx")
  end
end
