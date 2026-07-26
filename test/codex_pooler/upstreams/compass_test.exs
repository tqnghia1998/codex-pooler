defmodule CodexPooler.Upstreams.CompassTest do
  use CodexPooler.DataCase, async: false

  import CodexPooler.PoolerFixtures

  alias CodexPooler.Catalog.Sync.Discovery
  alias CodexPooler.FakeUpstream
  alias CodexPooler.Upstreams.Compass
  alias CodexPooler.Upstreams.Reconciliation.UsageProbe

  test "routes public and backend Responses endpoints directly to Compass" do
    assert Compass.direct_endpoint("/v1/responses") == "/responses"
    assert Compass.direct_endpoint("/backend-api/codex/responses") == "/responses"
  end

  test "project_detail_url path-encodes the project id" do
    identity = %CodexPooler.Upstreams.Schemas.UpstreamIdentity{
      metadata: %{
        "provider" => "compass",
        "base_url" => "https://compass.example/compass-api/v1",
        "project_id" => "team/project 1"
      }
    }

    assignment = %CodexPooler.Upstreams.Schemas.PoolUpstreamAssignment{metadata: %{}}

    assert {:ok, url} = Compass.project_detail_url(identity, assignment)

    assert url ==
             "https://compass.example/compass-api/v1/open_project/detail/team%2Fproject%201"
  end

  test "quota_windows converts recurring Compass project balance into a monthly account window" do
    observed_at = DateTime.new!(~D[2025-01-15], ~T[12:00:00], "Etc/UTC")

    assert {:ok, [window]} =
             Compass.quota_windows(
               %{
                 "retcode" => 0,
                 "data" => %{
                   "project" => %{
                     "budget_type" => "recurring",
                     "quota_detail" => %{
                       "applied_balance" => 100.0,
                       "balance" => 74.5,
                       "plan" => "partnered"
                     }
                   }
                 }
               },
               observed_at
             )

    assert window.source == "compass_project_api"
    assert window.quota_key == "account"
    assert window.window_kind == "primary"
    assert window.window_minutes == 44_640
    assert window.reset_at == DateTime.new!(~D[2025-02-01], ~T[00:00:00], "Etc/UTC")
    assert Decimal.eq?(window.used_percent, Decimal.new("25.5"))
    assert window.metadata["budget_type"] == "recurring"
  end

  test "fetch_models_for_assignment uses Compass /models" do
    {:ok, fake} =
      FakeUpstream.start_link(
        {:path_json,
         %{
           "/compass-api/v1/models" => {200, %{"data" => [%{"id" => "gpt-4o"}]}}
         }}
      )

    on_exit(fn -> FakeUpstream.stop(fake) end)

    %{identity: identity, assignment: assignment} =
      active_upstream_assignment_fixture(pool_fixture(), %{
        chatgpt_account_id: nil,
        account_email: "compass+models@compass.local",
        metadata: %{
          "provider" => "compass",
          "base_url" => FakeUpstream.url(fake) <> "/compass-api/v1",
          "project_id" => "project-models"
        }
      })

    assert {:ok, [model]} =
             Discovery.fetch_models_for_assignment(%{identity: identity, assignment: assignment})

    assert model["id"] == "gpt-4o"
  end

  test "fetch_from_identity reads Compass project quota with the shared gateway token" do
    {:ok, fake} =
      FakeUpstream.start_link(
        {:path_json,
         %{
           "/compass-api/v1/open_project/detail/project-id" =>
             {200,
              %{
                "retcode" => 0,
                "data" => %{
                  "project" => %{
                    "budget_type" => "recurring",
                    "quota_detail" => %{
                      "applied_balance" => 100.0,
                      "balance" => 74.5,
                      "plan" => "partnered"
                    }
                  }
                }
              }}
         }}
      )

    on_exit(fn -> FakeUpstream.stop(fake) end)
    put_compass_gateway_token("gateway-token")

    %{identity: identity, assignment: assignment} =
      active_upstream_assignment_fixture(pool_fixture(), %{
        chatgpt_account_id: nil,
        account_email: "compass+quota@compass.local",
        metadata: %{
          "provider" => "compass",
          "base_url" => FakeUpstream.url(fake) <> "/compass-api/v1",
          "project_id" => "project-id"
        }
      })

    observed_at = DateTime.utc_now() |> DateTime.truncate(:microsecond)

    assert {:ok, %UsageProbe.Result{windows: [window]}} =
             UsageProbe.fetch_from_identity(identity, assignment, observed_at, [])

    assert window.source == "compass_project_api"
    assert Decimal.eq?(window.used_percent, Decimal.new("25.5"))
  end

  test "fetch_from_identity preserves Compass project quota fetch errors" do
    {:ok, fake} =
      FakeUpstream.start_link(
        {:path_json,
         %{
           "/compass-api/v1/open_project/detail/project-id" =>
             {503, %{"retcode" => -1, "message" => "unavailable"}}
         }}
      )

    on_exit(fn -> FakeUpstream.stop(fake) end)
    put_compass_gateway_token("gateway-token")

    %{identity: identity, assignment: assignment} =
      active_upstream_assignment_fixture(pool_fixture(), %{
        chatgpt_account_id: nil,
        account_email: "compass+quota-error@compass.local",
        metadata: %{
          "provider" => "compass",
          "base_url" => FakeUpstream.url(fake) <> "/compass-api/v1",
          "project_id" => "project-id"
        }
      })

    assert {:error, {:upstream_status, 503}} =
             UsageProbe.fetch_from_identity(
               identity,
               assignment,
               DateTime.utc_now() |> DateTime.truncate(:microsecond),
               []
             )
  end

  defp put_compass_gateway_token(value) do
    previous = System.get_env("CODEX_POOLER_COMPASS_GATEWAY_TOKEN")
    System.put_env("CODEX_POOLER_COMPASS_GATEWAY_TOKEN", value)

    on_exit(fn ->
      if is_nil(previous) do
        System.delete_env("CODEX_POOLER_COMPASS_GATEWAY_TOKEN")
      else
        System.put_env("CODEX_POOLER_COMPASS_GATEWAY_TOKEN", previous)
      end
    end)
  end
end
