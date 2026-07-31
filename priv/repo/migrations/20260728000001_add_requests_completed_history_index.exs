defmodule CodexPooler.Repo.Migrations.AddRequestsCompletedHistoryIndex do
  use Ecto.Migration

  @disable_ddl_transaction true
  @disable_migration_lock true

  # Supports bounded retention pruning of terminal request trees by completion age.
  def up do
    execute("""
    CREATE INDEX CONCURRENTLY IF NOT EXISTS requests_completed_history_idx
    ON requests (completed_at)
    WHERE status IN ('succeeded', 'failed', 'rejected', 'cancelled')
      AND completed_at IS NOT NULL
    """)
  end

  def down do
    execute("DROP INDEX CONCURRENTLY IF EXISTS requests_completed_history_idx")
  end
end
