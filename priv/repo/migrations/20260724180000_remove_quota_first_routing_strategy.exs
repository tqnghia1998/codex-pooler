defmodule CodexPooler.Repo.Migrations.RemoveQuotaFirstRoutingStrategy do
  use Ecto.Migration

  @old_constraint "pool_routing_settings_routing_strategy_check"

  def up do
    execute("""
    UPDATE pool_routing_settings
    SET routing_strategy = 'least_recent_success'
    WHERE routing_strategy = 'quota_first'
    """)

    execute("ALTER TABLE pool_routing_settings DROP CONSTRAINT IF EXISTS #{@old_constraint}")

    execute("""
    ALTER TABLE pool_routing_settings
    ADD CONSTRAINT #{@old_constraint}
    CHECK (routing_strategy = ANY (ARRAY['bridge_ring', 'deterministic_rotation', 'least_recent_success']))
    """)
  end

  def down do
    execute("ALTER TABLE pool_routing_settings DROP CONSTRAINT IF EXISTS #{@old_constraint}")

    execute("""
    ALTER TABLE pool_routing_settings
    ADD CONSTRAINT #{@old_constraint}
    CHECK (routing_strategy = ANY (ARRAY['bridge_ring', 'deterministic_rotation', 'least_recent_success', 'quota_first']))
    """)
  end
end
