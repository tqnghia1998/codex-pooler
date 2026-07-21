defmodule CodexPoolerWeb.Admin.Format do
  @moduledoc """
  Shared formatting helpers for operator-facing admin presentation.
  """

  @money_places 2
  @micros_per_usd Decimal.new(1_000_000)
  @token_scales [
    {1_000_000_000, "B"},
    {1_000_000, "M"},
    {1_000, "k"}
  ]

  @spec money(Decimal.t() | integer() | float()) :: String.t()
  def money(%Decimal{} = usd) do
    usd
    |> Decimal.round(@money_places)
    |> Decimal.to_string(:normal)
    |> fixed_decimal_places(@money_places)
    |> add_group_separators()
    |> then(&"$#{&1}")
  end

  def money(value) when is_integer(value), do: value |> Decimal.new() |> money()
  def money(value) when is_float(value), do: value |> Decimal.from_float() |> money()

  @spec money_from_micros(integer()) :: String.t()
  def money_from_micros(micros) when is_integer(micros) do
    micros
    |> Decimal.new()
    |> Decimal.div(@micros_per_usd)
    |> money()
  end

  @doc """
  Money with elastic precision: amounts routinely land below one cent, where
  the ledger-style two-decimal rounding collapses everything to $0.01/$0.00.
  Small amounts keep up to four decimals (trimmed, minimum two); from ten
  cents up the regular money format applies.
  """
  @spec money_precise(Decimal.t() | integer() | float()) :: String.t()
  def money_precise(%Decimal{} = usd) do
    abs = Decimal.abs(usd)

    cond do
      Decimal.compare(abs, Decimal.new("0.1")) != :lt ->
        money(usd)

      Decimal.compare(abs, Decimal.new(0)) == :eq ->
        money(usd)

      Decimal.compare(Decimal.round(abs, 4), Decimal.new(0)) == :eq ->
        "<$0.0001"

      true ->
        usd
        |> Decimal.round(4)
        |> Decimal.to_string(:normal)
        |> trim_trailing_money_zeros()
        |> then(&"$#{&1}")
    end
  end

  def money_precise(value) when is_integer(value), do: value |> Decimal.new() |> money_precise()

  def money_precise(value) when is_float(value),
    do: value |> Decimal.from_float() |> money_precise()

  @spec money_precise_from_micros(integer()) :: String.t()
  def money_precise_from_micros(micros) when is_integer(micros) do
    micros
    |> Decimal.new()
    |> Decimal.div(@micros_per_usd)
    |> money_precise()
  end

  @spec token_count(integer() | float() | Decimal.t() | nil) :: String.t()
  def token_count(nil), do: "0"

  def token_count(%Decimal{} = value),
    do: value |> Decimal.round(0) |> Decimal.to_integer() |> token_count()

  def token_count(value) when is_float(value), do: value |> round() |> token_count()

  def token_count(value) when is_integer(value) do
    sign = if value < 0, do: "-", else: ""
    absolute = abs(value)

    case Enum.find(@token_scales, fn {scale, _suffix} -> absolute >= scale end) do
      nil ->
        sign <> Integer.to_string(absolute)

      {scale, suffix} ->
        sign <> compact_scaled(absolute, scale) <> suffix
    end
  end

  @spec integer(integer() | Decimal.t() | nil) :: String.t()
  def integer(nil), do: "0"

  def integer(%Decimal{} = value),
    do: value |> Decimal.round(0) |> Decimal.to_integer() |> integer()

  def integer(value) when is_integer(value) do
    value
    |> Integer.to_string()
    |> add_group_separators()
  end

  defp compact_scaled(value, scale) do
    value
    |> Kernel./(scale)
    |> :erlang.float_to_binary(decimals: 1)
    |> String.trim_trailing("0")
    |> String.trim_trailing(".")
  end

  defp trim_trailing_money_zeros(value) do
    case String.split(value, ".", parts: 2) do
      [int_part, frac_part] ->
        trimmed = String.trim_trailing(frac_part, "0")

        frac_part =
          if String.length(trimmed) < 2, do: String.slice(frac_part, 0, 2), else: trimmed

        "#{int_part}.#{frac_part}"

      [int_part] ->
        "#{int_part}.00"
    end
  end

  defp fixed_decimal_places(value, places) do
    case String.split(value, ".", parts: 2) do
      [whole] ->
        whole <> "." <> String.duplicate("0", places)

      [whole, fraction] ->
        whole <> "." <> (fraction |> String.pad_trailing(places, "0") |> String.slice(0, places))
    end
  end

  defp add_group_separators(value) do
    {sign, value} =
      case value do
        "-" <> unsigned -> {"-", unsigned}
        unsigned -> {"", unsigned}
      end

    [whole | rest] = String.split(value, ".", parts: 2)

    grouped =
      whole
      |> String.graphemes()
      |> Enum.reverse()
      |> Enum.chunk_every(3)
      |> Enum.map(&Enum.reverse/1)
      |> Enum.reverse()
      |> Enum.map_join(",", &Enum.join/1)

    sign <> Enum.join([grouped | rest], ".")
  end

  @doc """
  Censors email strings by removing the email domain part and replacing
  alphanumeric characters in the local part with pseudo-random characters while
  preserving non-alphanumeric characters (such as `.`, `-`, `_`, `+`). First character
  is retained. Non-email binaries are returned unchanged.

  Example:
    "quangnghia.trinh@shopee.com" -> "q..." (domain removed)
  """
  @spec censor_email(term()) :: term()
  def censor_email(value) when is_binary(value) do
    case String.split(value, "@", parts: 2) do
      [local, domain] when local != "" and domain != "" ->
        censor_local_part(local, value)

      _other ->
        value
    end
  end

  def censor_email(value), do: value

  defp censor_local_part(local, seed_source) do
    alphabet = ~c"abcdefghijklmnopqrstuvwxyz0123456789"
    alphabet_len = length(alphabet)

    local
    |> String.graphemes()
    |> Enum.with_index()
    |> Enum.map(fn
      {grapheme, 0} ->
        grapheme

      {grapheme, idx} ->
        if String.match?(grapheme, ~r/^[A-Za-z0-9]$/) do
          hash = :crypto.hash(:sha256, "#{seed_source}:#{idx}")
          <<num::unsigned-big-integer-32, _rest::binary>> = hash
          char_code = Enum.at(alphabet, rem(num, alphabet_len))
          <<char_code::utf8>>
        else
          grapheme
        end
    end)
    |> Enum.join()
  end
end
