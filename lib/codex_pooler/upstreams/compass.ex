defmodule CodexPooler.Upstreams.Compass do
  @moduledoc false

  alias CodexPooler.Quotas.Evidence
  alias CodexPooler.Upstreams.EndpointMetadata
  alias CodexPooler.Upstreams.Schemas.{PoolUpstreamAssignment, UpstreamIdentity}

  @provider "compass"
  @quota_source "compass_project_api"

  @spec enabled?(UpstreamIdentity.t(), PoolUpstreamAssignment.t()) :: boolean()
  def enabled?(identity, assignment), do: provider(identity, assignment) == @provider

  @spec direct_endpoint(String.t() | nil) :: String.t() | nil
  def direct_endpoint("/v1/chat/completions"), do: "/chat/completions"
  def direct_endpoint("/v1/responses"), do: "/responses"
  def direct_endpoint(_source_endpoint), do: nil

  @spec project_detail_url(UpstreamIdentity.t(), PoolUpstreamAssignment.t()) ::
          {:ok, String.t()} | {:error, :missing_project_id | :invalid_upstream_base_url}
  def project_detail_url(identity, assignment) do
    with project_id when is_binary(project_id) and project_id != "" <-
           project_id(identity, assignment),
         {:ok, base} <- EndpointMetadata.endpoint_url(identity, assignment, "") do
      {:ok,
       String.trim_trailing(base, "/") <>
         "/open_project/detail/" <> URI.encode(project_id, &URI.char_unreserved?/1)}
    else
      nil -> {:error, :missing_project_id}
      {:error, _reason} -> {:error, :invalid_upstream_base_url}
    end
  end

  @spec quota_windows(map(), DateTime.t()) :: {:ok, [map()]} | {:error, :invalid_quota_payload}
  def quota_windows(payload, observed_at)
      when is_map(payload) and is_struct(observed_at, DateTime) do
    with 0 <- Map.get(payload, "retcode"),
         %{} = quota <- get_in(payload, ["data", "project", "quota_detail"]),
         {:ok, applied_balance} <- decimal(Map.get(quota, "applied_balance")),
         true <- Decimal.positive?(applied_balance),
         {:ok, balance} <- decimal(Map.get(quota, "balance")) do
      used_percent =
        applied_balance
        |> Decimal.sub(balance)
        |> Decimal.div(applied_balance)
        |> Decimal.mult(Decimal.new(100))
        |> clamp_percent()

      budget_type = get_in(payload, ["data", "project", "budget_type"])
      {window_minutes, reset_at} = quota_window_timing(budget_type, observed_at)

      {:ok,
       [
         %{
           quota_key: "account",
           window_kind: "primary",
           window_minutes: window_minutes,
           active_limit: whole_number_or_nil(applied_balance),
           used_percent: used_percent,
           display_label: "Project quota",
           limit_name: "Compass project balance",
           source: @quota_source,
           source_precision: "authoritative",
           quota_scope: "account",
           quota_family: "account",
           freshness_state: "fresh",
           last_sync_at: observed_at,
           observed_at: observed_at,
           reset_at: reset_at,
           merge_precedence: Evidence.merge_precedence(@quota_source, nil, "authoritative"),
           metadata: %{
             "applied_balance" => Decimal.to_string(applied_balance, :normal),
             "balance" => Decimal.to_string(balance, :normal),
             "plan" => Map.get(quota, "plan"),
             "budget_type" => budget_type
           }
         }
       ]}
    else
      _invalid -> {:error, :invalid_quota_payload}
    end
  end

  def quota_windows(_payload, _observed_at), do: {:error, :invalid_quota_payload}

  defp provider(identity, assignment) do
    [assignment.metadata, identity.metadata]
    |> Enum.find_value(fn
      %{} = metadata -> metadata["provider"]
      _metadata -> nil
    end)
    |> to_string()
    |> String.trim()
    |> String.downcase()
  end

  defp project_id(identity, assignment) do
    [assignment.metadata, identity.metadata]
    |> Enum.find_value(fn
      %{} = metadata -> present_string(metadata["compass_project_id"] || metadata["project_id"])
      _metadata -> nil
    end)
  end

  defp present_string(value) when is_binary(value) do
    case String.trim(value) do
      "" -> nil
      value -> value
    end
  end

  defp present_string(_value), do: nil

  defp decimal(value) when is_integer(value), do: {:ok, Decimal.new(value)}
  defp decimal(value) when is_float(value), do: {:ok, Decimal.from_float(value)}

  defp decimal(value) when is_binary(value) do
    case Decimal.parse(String.trim(value)) do
      {decimal, ""} -> {:ok, decimal}
      _invalid -> :error
    end
  end

  defp decimal(_value), do: :error

  defp clamp_percent(percent) do
    percent
    |> Decimal.max(Decimal.new(0))
    |> Decimal.min(Decimal.new(100))
  end

  defp quota_window_timing("recurring", %DateTime{} = observed_at) do
    current_month_start =
      DateTime.new!(Date.new!(observed_at.year, observed_at.month, 1), ~T[00:00:00], "Etc/UTC")

    next_month_start =
      case observed_at.month do
        12 -> DateTime.new!(Date.new!(observed_at.year + 1, 1, 1), ~T[00:00:00], "Etc/UTC")
        month -> DateTime.new!(Date.new!(observed_at.year, month + 1, 1), ~T[00:00:00], "Etc/UTC")
      end

    {DateTime.diff(next_month_start, current_month_start, :minute), next_month_start}
  end

  defp quota_window_timing(_budget_type, _observed_at), do: {1, nil}

  defp whole_number_or_nil(decimal) do
    if Decimal.equal?(decimal, Decimal.round(decimal, 0)), do: Decimal.to_integer(decimal)
  end
end
