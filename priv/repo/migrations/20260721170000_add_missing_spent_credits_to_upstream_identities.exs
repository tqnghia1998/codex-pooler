defmodule CodexPooler.Repo.Migrations.AddMissingSpentCreditsToUpstreamIdentities do
  use Ecto.Migration

  def up do
    execute("""
    ALTER TABLE upstream_identities
    ADD COLUMN IF NOT EXISTS spent_credits numeric NOT NULL DEFAULT 0
    """)
  end

  def down do
    execute("""
    ALTER TABLE upstream_identities
    DROP COLUMN IF EXISTS spent_credits
    """)
  end
end
