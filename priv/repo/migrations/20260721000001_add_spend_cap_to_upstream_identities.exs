defmodule CodexPooler.Repo.Migrations.AddSpendCapToUpstreamIdentities do
  use Ecto.Migration

  def up do
    alter table(:upstream_identities) do
      add :spend_cap_credits, :integer, null: false, default: 0
      add :spent_credits, :decimal, null: false, default: 0
      add :cap_started_at, :utc_datetime_usec
    end
  end

  def down do
    alter table(:upstream_identities) do
      remove :spend_cap_credits
      remove :spent_credits
      remove :cap_started_at
    end
  end
end
