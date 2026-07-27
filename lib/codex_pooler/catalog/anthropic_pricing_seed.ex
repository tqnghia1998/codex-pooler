defmodule CodexPooler.Catalog.AnthropicPricingSeed do
  @moduledoc """
  Seeds official Anthropic standard-tier pricing snapshots.

  Rates are USD per million tokens, captured 2026-07-26 from
  https://platform.claude.com/docs/en/about-claude/pricing. Dateless model IDs
  allow `PricingResolution` suffix inference to resolve dated variants.

  # ponytail: the schema has one cache-write rate, so 1-hour writes use the
  # 5-minute rate. Add duration-specific pricing if that usage becomes material.
  """

  alias CodexPooler.Catalog.PricingSnapshot
  alias CodexPooler.Repo

  @source "anthropic-list-pricing"
  @service_tier "standard"
  @price_bucket "default"
  @pricing_type "per_1m_tokens"
  @currency_code "USD"
  @billing_unit "token"
  @source_url "https://platform.claude.com/docs/en/about-claude/pricing"

  # {model_identifier, input, output, cache_write_5m, cache_hit, effective_at, price_version}
  @jan_2026 ~U[2026-01-01 00:00:00.000000Z]
  @sep_2026 ~U[2026-09-01 00:00:00.000000Z]

  @rates [
    {"claude-opus-5", "5.00", "25.00", "6.25", "0.50", @jan_2026, "2026-05-27"},
    {"claude-opus-4-8", "5.00", "25.00", "6.25", "0.50", @jan_2026, "2026-05-27"},
    {"claude-opus-4-7", "5.00", "25.00", "6.25", "0.50", @jan_2026, "2026-05-27"},
    {"claude-opus-4-6", "5.00", "25.00", "6.25", "0.50", @jan_2026, "2026-05-27"},
    {"claude-opus-4-5", "5.00", "25.00", "6.25", "0.50", @jan_2026, "2026-05-27"},
    {"claude-opus-4-1", "15.00", "75.00", "18.75", "1.50", @jan_2026, "2026-05-27"},
    {"claude-opus-4", "15.00", "75.00", "18.75", "1.50", @jan_2026, "2026-05-27"},
    {"claude-sonnet-4-6", "3.00", "15.00", "3.75", "0.30", @jan_2026, "2026-05-27"},
    {"claude-sonnet-4-5", "3.00", "15.00", "3.75", "0.30", @jan_2026, "2026-05-27"},
    {"claude-sonnet-4", "3.00", "15.00", "3.75", "0.30", @jan_2026, "2026-05-27"},
    {"claude-haiku-4-5", "1.00", "5.00", "1.25", "0.10", @jan_2026, "2026-05-27"},
    {"claude-haiku-3-5", "0.80", "4.00", "1.00", "0.08", @jan_2026, "2026-05-27"},
    {"claude-3-7-sonnet", "3.00", "15.00", "3.75", "0.30", @jan_2026, "2026-05-27"},
    {"claude-3-5-sonnet", "3.00", "15.00", "3.75", "0.30", @jan_2026, "2026-05-27"},
    {"claude-3-opus", "15.00", "75.00", "18.75", "1.50", @jan_2026, "2026-05-27"},
    {"claude-3-sonnet", "3.00", "15.00", nil, nil, @jan_2026, "2026-05-27"},

    # Claude Sonnet 5 ships with time-limited introductory pricing that steps
    # up to the standard rate on 2026-09-01; both rows are kept so settlement
    # automatically picks the correct one from each attempt's timestamp.
    {"claude-sonnet-5", "2.00", "10.00", "2.50", "0.20", @jan_2026, "2026-05-27-intro"},
    {"claude-sonnet-5", "3.00", "15.00", "3.75", "0.30", @sep_2026, "2026-05-27-standard"}
  ]

  @spec seed! :: {inserted :: non_neg_integer(), total :: non_neg_integer()}
  def seed! do
    now = DateTime.utc_now() |> DateTime.truncate(:microsecond)
    rows = Enum.map(@rates, &row(&1, now))
    {inserted, _rows} = Repo.insert_all(PricingSnapshot, rows, on_conflict: :nothing)
    {inserted, length(rows)}
  end

  @spec source :: String.t()
  def source, do: @source

  defp row(
         {model_identifier, input, output, cache_write, cache_hit, effective_at, price_version},
         now
       ) do
    %{
      model_identifier: model_identifier,
      price_version: "anthropic-list-#{price_version}",
      currency_code: @currency_code,
      billing_unit: @billing_unit,
      input_token_micros: Decimal.new(input),
      cached_input_token_micros: cache_hit && Decimal.new(cache_hit),
      cache_write_token_micros: cache_write && Decimal.new(cache_write),
      output_token_micros: Decimal.new(output),
      reasoning_token_micros: nil,
      request_base_micros: Decimal.new(0),
      effective_at: effective_at,
      source_url: @source_url,
      captured_at: now,
      config: %{
        "source" => @source,
        "service_tier" => @service_tier,
        "price_bucket" => @price_bucket,
        "pricing_type" => @pricing_type,
        "availability" => "priced"
      }
    }
  end
end
