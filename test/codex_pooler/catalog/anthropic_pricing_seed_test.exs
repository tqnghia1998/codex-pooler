defmodule CodexPooler.Catalog.AnthropicPricingSeedTest do
  use CodexPooler.DataCase, async: true

  alias CodexPooler.Accounting.PricingResolution
  alias CodexPooler.Catalog.AnthropicPricingSeed
  alias CodexPooler.Catalog.Model
  alias CodexPooler.Catalog.PricingSnapshot
  alias CodexPooler.Repo

  test "seed!/0 is idempotent and only inserts anthropic-sourced rows" do
    assert {_inserted, total} = AnthropicPricingSeed.seed!()
    assert {0, ^total} = AnthropicPricingSeed.seed!()

    count =
      Repo.aggregate(
        Ecto.Query.from(p in PricingSnapshot,
          where: fragment("?->>'source'", p.config) == ^AnthropicPricingSeed.source()
        ),
        :count
      )

    assert count == total
  end

  test "claude-sonnet-5 resolves priced snapshots before and after the introductory cutover" do
    model = %Model{
      id: Ecto.UUID.generate(),
      exposed_model_id: "claude-sonnet-5",
      upstream_model_id: "claude-sonnet-5"
    }

    intro = PricingResolution.lookup(model, "claude-sonnet-5", %{}, %{}, ~U[2026-07-26 00:00:00Z])
    assert intro.status == "priced"
    assert Decimal.equal?(intro.snapshot.input_token_micros, Decimal.new("2.00"))

    standard =
      PricingResolution.lookup(model, "claude-sonnet-5", %{}, %{}, ~U[2026-10-01 00:00:00Z])

    assert standard.status == "priced"
    assert Decimal.equal?(standard.snapshot.input_token_micros, Decimal.new("3.00"))
  end

  test "dated model ids resolve via suffix inference to the dateless Anthropic pricing alias" do
    model = %Model{
      id: Ecto.UUID.generate(),
      exposed_model_id: "claude-sonnet-4-5-20250929",
      upstream_model_id: "claude-sonnet-4-5-20250929"
    }

    pricing =
      PricingResolution.lookup(
        model,
        "claude-sonnet-4-5-20250929",
        %{},
        %{},
        ~U[2026-07-26 00:00:00Z]
      )

    assert pricing.status == "priced"
    assert pricing.snapshot.model_identifier == "claude-sonnet-4-5"

    assert pricing.alias == %{
             "source" => "suffix_inference",
             "from" => "claude-sonnet-4-5-20250929",
             "to" => "claude-sonnet-4-5"
           }
  end

  test "cost_micros/2 correctly bills cache-read and cache-write tokens at their own rates" do
    model = %Model{
      id: Ecto.UUID.generate(),
      exposed_model_id: "claude-sonnet-5",
      upstream_model_id: "claude-sonnet-5"
    }

    pricing =
      PricingResolution.lookup(model, "claude-sonnet-5", %{}, %{}, ~U[2026-07-26 00:00:00Z])

    usage = %{
      input_tokens: 25,
      cached_input_tokens: 10,
      cache_write_tokens: 50,
      output_tokens: 15,
      reasoning_tokens: 0
    }

    # standard_input = max(25 - 10 - 50, 0) = 0
    # 0*2.00 + 10*0.20 + 50*2.50 + 15*10.00 = 0 + 2 + 125 + 150 = 277
    assert PricingResolution.cost_micros(pricing.snapshot, usage) == Decimal.new("277.000000000")
  end
end
