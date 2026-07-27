defmodule CodexPooler.Repo.Migrations.SeedAnthropicPricingSnapshots do
  use Ecto.Migration

  @source "anthropic-list-pricing"

  def up do
    execute("""
    INSERT INTO public.pricing_snapshots (
      id,
      model_identifier,
      price_version,
      currency_code,
      billing_unit,
      input_token_micros,
      cached_input_token_micros,
      cache_write_token_micros,
      output_token_micros,
      reasoning_token_micros,
      request_base_micros,
      effective_at,
      source_url,
      captured_at,
      config
    )
    SELECT
      gen_random_uuid(),
      model_identifier,
      'anthropic-list-' || price_version,
      'USD',
      'token',
      input_token_micros,
      cached_input_token_micros,
      cache_write_token_micros,
      output_token_micros,
      NULL,
      0,
      effective_at,
      'https://platform.claude.com/docs/en/about-claude/pricing',
      timezone('UTC', now()),
      '{"source":"#{@source}","service_tier":"standard","price_bucket":"default","pricing_type":"per_1m_tokens","availability":"priced"}'::jsonb
    FROM (VALUES
      ('claude-opus-5', '5.00'::numeric, '25.00'::numeric, '6.25'::numeric, '0.50'::numeric, '2026-01-01'::timestamptz, '2026-05-27'),
      ('claude-opus-4-8', 5.00, 25.00, 6.25, 0.50, '2026-01-01'::timestamptz, '2026-05-27'),
      ('claude-opus-4-7', 5.00, 25.00, 6.25, 0.50, '2026-01-01'::timestamptz, '2026-05-27'),
      ('claude-opus-4-6', 5.00, 25.00, 6.25, 0.50, '2026-01-01'::timestamptz, '2026-05-27'),
      ('claude-opus-4-5', 5.00, 25.00, 6.25, 0.50, '2026-01-01'::timestamptz, '2026-05-27'),
      ('claude-opus-4-1', 15.00, 75.00, 18.75, 1.50, '2026-01-01'::timestamptz, '2026-05-27'),
      ('claude-opus-4', 15.00, 75.00, 18.75, 1.50, '2026-01-01'::timestamptz, '2026-05-27'),
      ('claude-sonnet-4-6', 3.00, 15.00, 3.75, 0.30, '2026-01-01'::timestamptz, '2026-05-27'),
      ('claude-sonnet-4-5', 3.00, 15.00, 3.75, 0.30, '2026-01-01'::timestamptz, '2026-05-27'),
      ('claude-sonnet-4', 3.00, 15.00, 3.75, 0.30, '2026-01-01'::timestamptz, '2026-05-27'),
      ('claude-haiku-4-5', 1.00, 5.00, 1.25, 0.10, '2026-01-01'::timestamptz, '2026-05-27'),
      ('claude-haiku-3-5', 0.80, 4.00, 1.00, 0.08, '2026-01-01'::timestamptz, '2026-05-27'),
      ('claude-3-7-sonnet', 3.00, 15.00, 3.75, 0.30, '2026-01-01'::timestamptz, '2026-05-27'),
      ('claude-3-5-sonnet', 3.00, 15.00, 3.75, 0.30, '2026-01-01'::timestamptz, '2026-05-27'),
      ('claude-3-opus', 15.00, 75.00, 18.75, 1.50, '2026-01-01'::timestamptz, '2026-05-27'),
      ('claude-3-sonnet', 3.00, 15.00, NULL, NULL, '2026-01-01'::timestamptz, '2026-05-27'),
      ('claude-sonnet-5', 2.00, 10.00, 2.50, 0.20, '2026-01-01'::timestamptz, '2026-05-27-intro'),
      ('claude-sonnet-5', 3.00, 15.00, 3.75, 0.30, '2026-09-01'::timestamptz, '2026-05-27-standard')
    ) AS rates(
      model_identifier,
      input_token_micros,
      output_token_micros,
      cache_write_token_micros,
      cached_input_token_micros,
      effective_at,
      price_version
    )
    ON CONFLICT DO NOTHING
    """)
  end

  def down do
    execute("""
    DELETE FROM public.pricing_snapshots
    WHERE config ->> 'source' = '#{@source}'
    """)
  end
end
