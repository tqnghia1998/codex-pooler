defmodule CodexPooler.Gateway.Routing.BridgeRingStatusTest do
  use CodexPooler.DataCase, async: false

  import CodexPooler.PoolerFixtures

  alias CodexPooler.Gateway.Persistence.{BridgeAffinity, BridgeDemotion, RoutingCircuitState}
  alias CodexPooler.Gateway.Routing.BridgeRing
  alias CodexPooler.Pools
  alias CodexPooler.Repo

  describe "routing_status/1" do
    test "summarizes persisted bridge routing health for a Pool" do
      %{pool: pool, api_key: api_key} = active_api_key_fixture()
      first = upstream_assignment_fixture(pool)
      second = upstream_assignment_fixture(pool)
      other_pool = pool_fixture()
      %{api_key: other_api_key} = active_api_key_fixture(other_pool)
      other = upstream_assignment_fixture(other_pool)
      now = usec(~U[2026-06-08 08:00:00Z])

      pool
      |> Pools.ensure_routing_settings()
      |> Ecto.Changeset.change(%{
        routing_strategy: "least_recent_success",
        bridge_ring_size: 7,
        sticky_http_sessions: true,
        updated_at: now
      })
      |> Repo.update!()

      insert_affinity!(pool, api_key, first, now)
      insert_affinity!(pool, api_key, first, now, status: "replaced")
      insert_affinity!(other_pool, other_api_key, other, now)

      older_demotion = insert_demotion!(pool, api_key, first, DateTime.add(now, -30, :second))
      newer_demotion = insert_demotion!(pool, api_key, second, now)
      insert_demotion!(pool, api_key, first, now, status: "resolved")
      insert_demotion!(other_pool, other_api_key, other, now)

      open_circuit =
        insert_circuit!(pool, api_key, first, DateTime.add(now, -20, :second), "open")

      half_open_circuit = insert_circuit!(pool, api_key, second, now, "half_open")
      insert_circuit!(pool, api_key, first, now, "closed")
      insert_circuit!(other_pool, other_api_key, other, now, "open")

      status = BridgeRing.routing_status(pool)

      assert status.settings.pool_id == pool.id
      assert status.settings.routing_strategy == "least_recent_success"
      assert status.settings.bridge_ring_size == 7
      assert status.settings.sticky_http_sessions
      assert status.active_affinity_count == 1
      assert status.active_demotion_count == 2
      assert Enum.map(status.recent_demotions, & &1.id) == [newer_demotion.id, older_demotion.id]
      assert status.active_circuit_count == 2
      assert Enum.map(status.recent_circuits, & &1.id) == [half_open_circuit.id, open_circuit.id]
    end

    test "returns default settings for pools without persisted routing settings" do
      pool = pool_fixture()

      status = BridgeRing.routing_status(pool.id)

      assert status.settings.pool_id == pool.id
      assert status.settings.routing_strategy == "least_recent_success"
      assert status.settings.bridge_ring_size == 3
      assert status.settings.sticky_websocket_sessions
      assert status.settings.sticky_http_sessions
      assert status.active_affinity_count == 0
      assert status.active_demotion_count == 0
      assert status.active_circuit_count == 0
      assert status.recent_demotions == []
      assert status.recent_circuits == []
    end

    test "returns an empty status for invalid pool references" do
      assert %{
               settings: nil,
               active_affinity_count: 0,
               active_demotion_count: 0,
               active_circuit_count: 0,
               recent_demotions: [],
               recent_circuits: []
             } = BridgeRing.routing_status(:invalid)
    end
  end

  defp insert_affinity!(pool, api_key, fixture, now, attrs \\ []) do
    %BridgeAffinity{
      pool_id: pool.id,
      api_key_id: api_key.id,
      model_identifier: "gpt-gateway-status",
      affinity_kind: "request_correlation",
      affinity_key_hash: :crypto.hash(:sha256, "affinity-#{System.unique_integer([:positive])}"),
      pool_upstream_assignment_id: fixture.assignment.id,
      upstream_identity_id: fixture.identity.id,
      status: Keyword.get(attrs, :status, "active"),
      last_hit_at: now,
      metadata: %{"source" => "bridge_status_test"},
      created_at: now,
      updated_at: now
    }
    |> Repo.insert!()
  end

  defp insert_demotion!(pool, api_key, fixture, updated_at, attrs \\ []) do
    %BridgeDemotion{
      pool_id: pool.id,
      api_key_id: api_key.id,
      model_identifier: "gpt-gateway-status",
      pool_upstream_assignment_id: fixture.assignment.id,
      upstream_identity_id: fixture.identity.id,
      reason_code: "gateway_status_test",
      status: Keyword.get(attrs, :status, "active"),
      demoted_until: DateTime.add(updated_at, 300, :second),
      attempt_count: 1,
      metadata: %{"source" => "bridge_status_test"},
      created_at: updated_at,
      updated_at: updated_at
    }
    |> Repo.insert!()
  end

  defp insert_circuit!(pool, api_key, fixture, updated_at, status) do
    %RoutingCircuitState{}
    |> RoutingCircuitState.changeset(%{
      pool_id: pool.id,
      api_key_id: api_key.id,
      pool_upstream_assignment_id: fixture.assignment.id,
      upstream_identity_id: fixture.identity.id,
      model_identifier: "gpt-gateway-status",
      route_class: "proxy_stream",
      status: status,
      reason_code: "gateway_status_test",
      failure_count: if(status == "closed", do: 0, else: 3),
      success_count: 0,
      opened_at: if(status == "open", do: updated_at),
      half_opened_at: if(status == "half_open", do: updated_at),
      next_probe_at: if(status == "open", do: DateTime.add(updated_at, 60, :second)),
      metadata: %{"source" => "bridge_status_test"},
      created_at: updated_at,
      updated_at: updated_at
    })
    |> Repo.insert!()
  end

  defp usec(%DateTime{} = timestamp) do
    %{timestamp | microsecond: {elem(timestamp.microsecond, 0), 6}}
  end
end
