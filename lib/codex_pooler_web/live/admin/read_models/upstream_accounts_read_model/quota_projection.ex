defmodule CodexPoolerWeb.Admin.UpstreamAccountsReadModel.QuotaProjection do
  @moduledoc false

  alias CodexPooler.Admin.UpstreamQuotaReadiness
  alias CodexPooler.Quotas.ModelWeeklyResetSemantics
  alias CodexPooler.Upstreams.Quota
  alias CodexPooler.Upstreams.Quota.Charts.Measurements
  alias CodexPooler.Upstreams.Quota.WindowSelector
  alias CodexPoolerWeb.Admin.UpstreamAccountsReadModel.Formatting
  alias CodexPoolerWeb.DateTimeDisplay
  alias CodexPoolerWeb.RelativeTime

  @quota_priming_labels %{
    "unknown" => "Priming pending",
    "refreshing" => "Reconciling quota",
    "known" => "Quota known",
    "weekly_only_probe" => "Weekly-only probe",
    "stale" => "Quota stale",
    "expired" => "Quota expired",
    "failed" => "Quota failed",
    "blocked" => "Priming blocked",
    "resetless_unprimed" => "Quota reset missing",
    "unprimed" => "Quota unprimed"
  }

  @observed_zero_use_sources ~w(
    codex_usage_api
    codex_rate_limit_event
    codex_response_headers
    codex_rate_limit_error
  )
  @credits_per_dollar Decimal.new(25)

  @type quota_limit_row :: %{
          required(:key) => atom() | String.t(),
          required(:label) => String.t(),
          required(:percent) => Decimal.t() | nil,
          required(:percent_value) => number(),
          required(:percent_label) => String.t(),
          required(:count_label) => String.t() | nil,
          required(:reset_semantics) => :anchored | :floating | :unknown,
          required(:reset_at) => DateTime.t() | nil,
          required(:remaining_amount) => Decimal.t() | nil,
          required(:reset_label) => String.t() | nil,
          required(:reset_title) => String.t() | nil
        }

  @spec spend_cap_row(map(), DateTime.t() | nil) :: quota_limit_row() | nil
  def spend_cap_row(identity, last_active_at \\ nil)

  def spend_cap_row(%{spend_cap_credits: cap} = identity, last_active_at)
      when is_integer(cap) and cap > 0 do
    spent = spend_cap_spent(identity)
    cap = Decimal.new(cap)

    remaining = Decimal.max(Decimal.sub(cap, spent), Decimal.new(0))

    used_percent =
      spent
      |> Decimal.mult(Decimal.new(100))
      |> Decimal.div(cap)
      |> decimal_clamp_percent()

    %{
      key: :spending_cap,
      label: "Spending Cap",
      percent: used_percent,
      percent_value: Decimal.to_float(used_percent),
      percent_label: quota_percent_label(used_percent),
      count_label: "#{format_dollars(remaining)} left of #{format_dollars(cap)}",
      remaining_amount: nil,
      credit_backed: false,
      reset_semantics: :unknown,
      reset_at: nil,
      reset_label: last_active_label(last_active_at),
      reset_title: last_active_title(last_active_at)
    }
  end

  def spend_cap_row(_identity, _last_active_at) do
    zero = Decimal.new(0)

    %{
      key: :spending_cap,
      label: "Spending Cap",
      percent: nil,
      percent_value: 0,
      percent_label: "Not set",
      count_label: "#{format_dollars(zero)} left of #{format_dollars(zero)}",
      remaining_amount: nil,
      credit_backed: false,
      reset_semantics: :unknown,
      reset_at: nil,
      reset_label: nil,
      reset_title: nil
    }
  end

  @spec readiness([Quota.AccountQuotaWindow.t()], DateTime.t()) :: UpstreamQuotaReadiness.t()
  def readiness(windows, %DateTime{} = snapshot_at) when is_list(windows) do
    UpstreamQuotaReadiness.from_windows(windows, snapshot_at)
  end

  @spec assignment_priming_status(map()) :: String.t()
  def assignment_priming_status(%{metadata: %{"quota_priming" => %{"status" => status}}})
      when is_binary(status),
      do: status

  def assignment_priming_status(%{quota_priming_status: status}) when is_binary(status),
    do: status

  def assignment_priming_status(_assignment), do: "unknown"

  @spec assignment_priming_label(map() | String.t()) :: String.t()
  def assignment_priming_label(%{} = assignment) do
    assignment
    |> assignment_priming_status()
    |> assignment_priming_label()
  end

  def assignment_priming_label(status) when is_binary(status) do
    Map.get(@quota_priming_labels, status, String.replace(status, "_", " "))
  end

  @spec put_current_quota_priming(map(), map()) :: map()
  def put_current_quota_priming(assignment, quota_readiness) do
    case assignment_priming_status(assignment) do
      status when status in ["failed", "blocked"] ->
        put_quota_priming(assignment, status)

      _status ->
        put_derived_quota_priming(assignment, quota_readiness)
    end
  end

  defp put_derived_quota_priming(assignment, %{state: "ready"}) do
    put_quota_priming(assignment, "known")
  end

  defp put_derived_quota_priming(assignment, %{state: "weekly_only_probe"}) do
    put_quota_priming(assignment, "weekly_only_probe")
  end

  defp put_derived_quota_priming(assignment, _quota_readiness), do: assignment

  @spec quota_refresh_status([map()], DateTimeDisplay.preferences()) :: String.t()
  def quota_refresh_status(assignments, datetime_preferences) do
    assignments
    |> Enum.map(& &1.last_successful_refresh_at)
    |> Enum.reject(&is_nil/1)
    |> Enum.max_by(&DateTime.to_unix(&1, :microsecond), fn -> nil end)
    |> case do
      %DateTime{} = refreshed_at ->
        DateTimeDisplay.format_datetime(refreshed_at, datetime_preferences)

      nil ->
        "not run"
    end
  end

  @spec quota_limit_rows(
          [Quota.AccountQuotaWindow.t()],
          DateTimeDisplay.preferences(),
          DateTime.t()
        ) :: [quota_limit_row()]
  def quota_limit_rows(windows, datetime_preferences, %DateTime{} = snapshot_at)
      when is_list(windows) do
    monthly_quota = quota_account_window(windows, :monthly_primary, snapshot_at)
    non_recurring_compass_quota = non_recurring_compass_quota(windows, snapshot_at)

    additional_limits =
      windows
      |> Enum.reject(&account_quota_window?/1)
      |> Enum.reject(&spend_control_window?/1)
      |> Enum.filter(&informative_additional_quota_window?/1)
      |> Enum.sort_by(&quota_limit_sort_key/1)
      |> quota_limit_presentations()
      |> Enum.map(fn {window, key, label} ->
        quota_limit_row(
          key,
          label,
          window,
          datetime_preferences,
          snapshot_at
        )
      end)

    [
      quota_limit_row(
        :primary_5h,
        "5h",
        quota_account_window(windows, :primary_5h, snapshot_at),
        datetime_preferences,
        snapshot_at
      ),
      quota_limit_row(
        :primary_30d,
        if(is_nil(monthly_quota) and non_recurring_compass_quota,
          do: "Non-recurring",
          else: "30d"
        ),
        monthly_quota || non_recurring_compass_quota,
        datetime_preferences,
        snapshot_at
      ),
      quota_limit_row(
        :weekly,
        "Weekly",
        quota_account_window(windows, "secondary", snapshot_at),
        datetime_preferences,
        snapshot_at
      ),
      quota_limit_row(
        :monthly_quota,
        "Monthly Usage",
        Enum.find(
          WindowSelector.logical_windows(windows, snapshot_at),
          &(&1.quota_key == "spend_control")
        ),
        datetime_preferences,
        snapshot_at
      )
    ] ++ additional_limits
  end

  defp put_quota_priming(assignment, status) do
    assignment
    |> Map.put(:quota_priming_status, status)
    |> Map.put(:quota_priming_label, assignment_priming_label(status))
  end

  defp account_quota_window?(%Quota.AccountQuotaWindow{
         quota_key: "account",
         quota_scope: "account"
       }),
       do: true

  defp account_quota_window?(%Quota.AccountQuotaWindow{}), do: false

  # The monthly spend-control window already renders as its own fixed
  # "Monthly Usage" card (see quota_limit_rows/2); excluding it here keeps it
  # from also surfacing as a duplicate additional-limit card.
  defp spend_control_window?(%Quota.AccountQuotaWindow{quota_key: "spend_control"}), do: true
  defp spend_control_window?(%Quota.AccountQuotaWindow{}), do: false

  defp informative_additional_quota_window?(%Quota.AccountQuotaWindow{} = window) do
    not is_nil(quota_remaining_percent(window)) or not is_nil(quota_count_label(window))
  end

  defp quota_account_window(windows, "secondary", snapshot_at) do
    WindowSelector.best_account_window(windows, :weekly_secondary, snapshot_at)
  end

  defp quota_account_window(windows, descriptor, snapshot_at) do
    WindowSelector.best_account_window(windows, descriptor, snapshot_at)
  end

  defp non_recurring_compass_quota(windows, snapshot_at) do
    Enum.find(WindowSelector.logical_windows(windows, snapshot_at), fn
      %Quota.AccountQuotaWindow{
        source: "compass_project_api",
        quota_key: "account",
        quota_scope: "account",
        quota_family: "account",
        window_kind: "primary",
        window_minutes: 1
      } ->
        true

      _window ->
        false
    end)
  end

  defp spend_cap_spent(%{spent_credits: value}) when not is_nil(value), do: credit_amount(value)

  defp spend_cap_spent(%{metadata: metadata}) when is_map(metadata),
    do: credit_amount(Map.get(metadata, "spent_credits", 0))

  defp spend_cap_spent(_identity), do: Decimal.new(0)

  defp credit_amount(%Decimal{} = value), do: value
  defp credit_amount(value) when is_integer(value), do: Decimal.new(value)
  defp credit_amount(value) when is_float(value), do: Decimal.from_float(value)

  defp credit_amount(value) when is_binary(value) do
    case Decimal.parse(value) do
      {amount, ""} -> amount
      _invalid -> Decimal.new(0)
    end
  end

  defp credit_amount(_value), do: Decimal.new(0)

  defp format_dollars(credits) do
    credits
    |> Decimal.div(@credits_per_dollar)
    |> format_dollar_amount()
  end

  defp format_dollar_amount(amount) do
    amount
    |> Decimal.round(2)
    |> Decimal.to_string(:normal)
    |> then(&"$#{&1}")
  end

  defp last_active_label(%DateTime{} = last_active_at) do
    "active #{Formatting.format_reset_duration(DateTime.diff(DateTime.utc_now(), last_active_at, :second))} ago"
  end

  defp last_active_label(_last_active_at), do: nil

  defp last_active_title(%DateTime{} = last_active_at),
    do: "last active #{DateTime.to_iso8601(last_active_at)}"

  defp last_active_title(_last_active_at), do: nil

  defp quota_limit_sort_key(%Quota.AccountQuotaWindow{} = window) do
    {
      quota_scope_sort_value(window.quota_scope),
      quota_limit_label(window),
      window.window_kind,
      window.window_minutes || 0,
      window.quota_key,
      window.quota_family || "",
      window.model || "",
      window.upstream_model || ""
    }
  end

  defp quota_scope_sort_value("model"), do: 0
  defp quota_scope_sort_value("upstream_model"), do: 1
  defp quota_scope_sort_value("feature"), do: 2
  defp quota_scope_sort_value(_scope), do: 3

  defp quota_limit_key(%Quota.AccountQuotaWindow{} = window) do
    {scope, family, model, upstream_model, quota_key, window_kind, window_minutes} =
      WindowSelector.logical_key(window)

    [scope, family, model, upstream_model, quota_key, window_kind, window_minutes]
    |> Enum.map(&quota_identity_token/1)
    |> then(&"#{quota_limit_key_prefix(window)}-identity-#{Enum.join(&1, "-")}")
  end

  defp quota_limit_key_prefix(%Quota.AccountQuotaWindow{} = window) do
    [window.quota_scope, window.quota_key, window.window_kind, window.window_minutes]
    |> Enum.map_join("-", &quota_key_prefix_component/1)
  end

  defp quota_key_prefix_component(nil), do: "none"
  defp quota_key_prefix_component(value) when is_integer(value), do: Integer.to_string(value)

  defp quota_key_prefix_component(value) when is_binary(value) do
    value
    |> String.downcase()
    |> String.replace(~r/[^a-z0-9_-]+/u, "-")
    |> String.trim("-")
  end

  defp quota_identity_token(nil), do: "n"
  defp quota_identity_token(value) when is_integer(value), do: "i#{value}"

  defp quota_identity_token(value) when is_binary(value) do
    "s#{value |> Base.encode32(padding: false) |> String.downcase()}"
  end

  defp quota_limit_presentations(windows) do
    windows_by_legacy_key = Enum.group_by(windows, &quota_limit_key_prefix/1)
    labels_by_base = Enum.group_by(windows, &quota_limit_label/1)

    Enum.map(windows, fn window ->
      base_label = quota_limit_label(window)
      legacy_key = quota_limit_key_prefix(window)

      key =
        case Map.fetch!(windows_by_legacy_key, legacy_key) do
          [_window] -> legacy_key
          _colliding_windows -> quota_limit_key(window)
        end

      label =
        case Map.fetch!(labels_by_base, base_label) do
          [_window] -> base_label
          _colliding_windows -> "#{base_label} (#{quota_identity_label(window)})"
        end

      {window, key, label}
    end)
  end

  defp quota_limit_label(%Quota.AccountQuotaWindow{} = window) do
    window
    |> quota_limit_base_label()
    |> then(&"#{&1} #{quota_window_label(window)}")
  end

  defp quota_limit_base_label(%Quota.AccountQuotaWindow{} = window) do
    [
      window.display_label,
      window.model,
      window.upstream_model,
      window.limit_name,
      window.raw_limit_name,
      window.metered_feature,
      window.quota_key
    ]
    |> Enum.find(&Formatting.present_string?/1)
    |> humanize_quota_label()
  end

  defp quota_identity_label(%Quota.AccountQuotaWindow{} = window) do
    {scope, family, model, upstream_model, _quota_key, _window_kind, _window_minutes} =
      WindowSelector.logical_key(window)

    ([quota_scope_label(scope), identity_dimension_label("Family", family)] ++
       scope_identity_dimension_labels(scope, model, upstream_model))
    |> Enum.reject(&is_nil/1)
    |> Enum.join(", ")
  end

  defp quota_scope_label("model"), do: "Model scope"
  defp quota_scope_label("upstream_model"), do: "Upstream model scope"
  defp quota_scope_label("feature"), do: "Feature scope"
  defp quota_scope_label(scope), do: identity_dimension_label("Scope", scope)

  defp scope_identity_dimension_labels("model", model, _upstream_model),
    do: [identity_dimension_label("Model", model)]

  defp scope_identity_dimension_labels("upstream_model", _model, upstream_model),
    do: [identity_dimension_label("Upstream model", upstream_model)]

  defp scope_identity_dimension_labels(_scope, model, upstream_model) do
    [
      identity_dimension_label("Model", model),
      identity_dimension_label("Upstream model", upstream_model)
    ]
  end

  defp identity_dimension_label(_name, value) when not is_binary(value), do: nil

  defp identity_dimension_label(name, value) do
    value = String.trim(value)

    if value == "" do
      nil
    else
      "#{name} #{String.replace(value, ~r/[_-]+/u, " ")}"
    end
  end

  defp quota_window_label(%Quota.AccountQuotaWindow{window_kind: "primary", window_minutes: 300}),
    do: "5h"

  defp quota_window_label(%Quota.AccountQuotaWindow{
         window_kind: "primary",
         window_minutes: minutes
       })
       when is_integer(minutes),
       do: format_window_minutes(minutes)

  defp quota_window_label(%Quota.AccountQuotaWindow{window_kind: "primary"}), do: "Primary"

  defp quota_window_label(%Quota.AccountQuotaWindow{
         window_kind: "secondary",
         window_minutes: minutes
       })
       when minutes in [nil, 10_080],
       do: "Weekly"

  defp quota_window_label(%Quota.AccountQuotaWindow{
         window_kind: "secondary",
         window_minutes: minutes
       })
       when is_integer(minutes),
       do: format_window_minutes(minutes)

  defp quota_window_label(%Quota.AccountQuotaWindow{window_kind: window_kind})
       when is_binary(window_kind) do
    window_kind
    |> String.replace("_", " ")
    |> String.capitalize()
  end

  defp quota_window_label(%Quota.AccountQuotaWindow{}), do: "Window"

  defp format_window_minutes(minutes) when rem(minutes, 1_440) == 0,
    do: "#{div(minutes, 1_440)}d"

  defp format_window_minutes(minutes) when rem(minutes, 60) == 0,
    do: "#{div(minutes, 60)}h"

  defp format_window_minutes(minutes), do: "#{minutes}m"

  defp humanize_quota_label("codex_spark"), do: "GPT-5.3-Codex-Spark"
  defp humanize_quota_label("codex_other"), do: "GPT-5.3-Codex-Spark"
  defp humanize_quota_label("gpt_5_3_codex_spark"), do: "GPT-5.3-Codex-Spark"
  defp humanize_quota_label("gpt-5.3-codex-spark"), do: "GPT-5.3-Codex-Spark"

  defp humanize_quota_label(label) when is_binary(label) do
    label
    |> String.replace("_", " ")
    |> String.trim()
  end

  defp humanize_quota_label(_label), do: "Additional limit"

  defp quota_limit_row(
         key,
         label,
         %Quota.AccountQuotaWindow{} = window,
         datetime_preferences,
         snapshot_at
       ) do
    used_percent =
      case quota_remaining_percent(window) do
        %Decimal{} = remaining -> remaining_percent_from_used(remaining)
        nil -> nil
      end

    {reset_semantics, reset_at, reset_label, reset_title} =
      quota_reset_presentation(window, datetime_preferences, snapshot_at)

    %{
      key: key,
      label: label,
      percent: used_percent,
      percent_value: quota_percent_value(used_percent),
      percent_label: quota_percent_label(used_percent),
      count_label: quota_count_label(window),
      remaining_amount: quota_remaining_amount(window),
      credit_backed: credit_backed_window?(window),
      reset_semantics: reset_semantics,
      reset_at: reset_at,
      reset_label: reset_label,
      reset_title: reset_title
    }
  end

  defp quota_limit_row(key, label, nil, _datetime_preferences, _snapshot_at) do
    %{
      key: key,
      label: label,
      percent: nil,
      percent_value: 0,
      percent_label: "not reported",
      count_label: nil,
      remaining_amount: nil,
      credit_backed: false,
      reset_semantics: :unknown,
      reset_at: nil,
      reset_label: nil,
      reset_title: nil
    }
  end

  # A limit is credit-backed when credits with a known capacity drive its
  # meter (remaining = credits / capacity, the free-plan and dev-seed shape):
  # the card renders its progress bar striped to signal the value burns
  # credits. A bare credit balance beside a percent-based window (Pro weekly
  # rows carry the account balance too) does not make the meter
  # credit-backed.
  defp credit_backed_window?(%Quota.AccountQuotaWindow{
         credits: credits,
         active_limit: active_limit
       }),
       do: is_integer(credits) and is_integer(active_limit) and active_limit > 0

  defp quota_remaining_percent(%Quota.AccountQuotaWindow{
         quota_scope: scope,
         active_limit: active_limit,
         credits: credits,
         reset_at: %DateTime{},
         used_percent: %Decimal{} = used_percent,
         source: source,
         source_precision: source_precision
       })
       when scope in ["account", "model", "upstream_model"] and active_limit in [nil, 0] and
              credits in [nil, 0] and source in @observed_zero_use_sources and
              source_precision in ["observed", "authoritative"] do
    used_percent |> remaining_percent_from_used() |> decimal_clamp_percent()
  end

  defp quota_remaining_percent(%Quota.AccountQuotaWindow{
         quota_scope: scope,
         active_limit: active_limit,
         credits: credits,
         used_percent: %Decimal{} = used_percent
       })
       when scope in ["model", "upstream_model"] and active_limit in [nil, 0] and
              credits in [nil, 0] do
    if Decimal.compare(used_percent, Decimal.new(0)) == :gt do
      used_percent |> remaining_percent_from_used() |> decimal_clamp_percent()
    end
  end

  defp quota_remaining_percent(%Quota.AccountQuotaWindow{} = window) do
    window
    |> Measurements.for_window()
    |> Map.get(:remaining_percent)
  end

  defp quota_percent_value(%Decimal{} = percent) do
    percent
    |> Decimal.round(0)
    |> Decimal.to_integer()
  end

  defp quota_percent_value(_percent), do: 0

  defp quota_percent_label(%Decimal{} = percent), do: "#{quota_percent_value(percent)}%"
  defp quota_percent_label(_percent), do: "not reported"

  defp quota_count_label(%Quota.AccountQuotaWindow{
         quota_key: "spend_control",
         metadata: %{"spend_used" => used, "spend_cap" => cap}
       })
       when is_binary(used) and is_binary(cap) do
    with {used, ""} <- Decimal.parse(used),
         {cap, ""} <- Decimal.parse(cap) do
      "#{format_dollars(Decimal.max(Decimal.sub(cap, used), Decimal.new(0)))} left of #{format_dollars(cap)}"
    else
      _invalid -> "#{format_monthly_dollars(used)} left of #{format_monthly_dollars(cap)}"
    end
  end

  defp quota_count_label(%Quota.AccountQuotaWindow{
         source: "compass_project_api",
         metadata: %{"balance" => balance, "applied_balance" => cap}
       })
       when is_binary(balance) and is_binary(cap) do
    with {balance, ""} <- Decimal.parse(balance),
         {cap, ""} <- Decimal.parse(cap) do
      "#{format_dollar_amount(decimal_non_negative(balance))} left of #{format_dollar_amount(cap)}"
    else
      _invalid -> nil
    end
  end

  defp quota_count_label(%Quota.AccountQuotaWindow{credits: credits, active_limit: active_limit})
       when is_integer(credits) and is_integer(active_limit) and active_limit > 0 do
    "#{Formatting.format_integer(credits)} / #{Formatting.format_integer(active_limit)} credits"
  end

  defp quota_count_label(%Quota.AccountQuotaWindow{credits: credits, active_limit: active_limit})
       when is_integer(credits) and credits > 0 and active_limit in [nil, 0] do
    "#{Formatting.format_integer(credits)} credits"
  end

  defp quota_count_label(%Quota.AccountQuotaWindow{
         active_limit: active_limit,
         used_percent: %Decimal{} = used_percent
       })
       when is_integer(active_limit) and active_limit > 0 do
    remaining =
      active_limit
      |> Decimal.new()
      |> Decimal.mult(Decimal.sub(Decimal.new(100), used_percent))
      |> Decimal.div(Decimal.new(100))
      |> decimal_non_negative()
      |> Decimal.round(0)
      |> Decimal.to_integer()

    "#{Formatting.format_integer(remaining)} / #{Formatting.format_integer(active_limit)} credits"
  end

  defp quota_count_label(%Quota.AccountQuotaWindow{used_percent: %Decimal{}}), do: nil

  defp quota_count_label(%Quota.AccountQuotaWindow{}), do: nil

  defp quota_reset_presentation(window, datetime_preferences, snapshot_at) do
    case ModelWeeklyResetSemantics.classify(window) do
      :anchored ->
        anchored_reset_presentation(window.reset_at, datetime_preferences, snapshot_at)

      :floating ->
        {:floating, nil, "starts on use",
         "provider reports a rolling seven-day window until use starts"}

      :unknown ->
        {:unknown, nil, nil, nil}

      :not_applicable ->
        legacy_quota_reset_presentation(window, datetime_preferences, snapshot_at)
    end
  end

  defp legacy_quota_reset_presentation(
         %Quota.AccountQuotaWindow{metadata: metadata, reset_at: reset_at},
         datetime_preferences,
         snapshot_at
       )
       when is_map(metadata) do
    case Map.fetch(metadata, "reset_state") do
      {:ok, "floating"} ->
        {:floating, reset_at, "starts on use",
         "provider reports a rolling seven-day window until use starts"}

      {:ok, "anchored"} ->
        anchored_reset_presentation(reset_at, datetime_preferences, snapshot_at)

      {:ok, _reset_state} ->
        {:unknown, reset_at, nil, nil}

      :error ->
        anchored_reset_presentation(reset_at, datetime_preferences, snapshot_at)
    end
  end

  defp legacy_quota_reset_presentation(
         %Quota.AccountQuotaWindow{reset_at: reset_at},
         datetime_preferences,
         snapshot_at
       ) do
    anchored_reset_presentation(reset_at, datetime_preferences, snapshot_at)
  end

  defp anchored_reset_presentation(
         %DateTime{} = reset_at,
         datetime_preferences,
         snapshot_at
       ) do
    {:anchored, reset_at, quota_reset_label(reset_at, snapshot_at),
     quota_reset_title(reset_at, datetime_preferences)}
  end

  defp anchored_reset_presentation(_reset_at, _datetime_preferences, _snapshot_at),
    do: {:unknown, nil, nil, nil}

  defp quota_remaining_amount(%Quota.AccountQuotaWindow{
         quota_key: "spend_control",
         metadata: %{"spend_used" => used, "spend_cap" => cap}
       })
       when is_binary(used) and is_binary(cap) do
    with {used, ""} <- Decimal.parse(used),
         {cap, ""} <- Decimal.parse(cap) do
      Decimal.sub(cap, used)
    else
      _invalid -> nil
    end
  end

  defp quota_remaining_amount(_window), do: nil

  defp format_monthly_dollars(value) do
    case Decimal.parse(value) do
      {credits, ""} -> format_dollars(credits)
      _invalid -> value
    end
  end

  defp quota_reset_label(%DateTime{} = reset_at, %DateTime{} = snapshot_at) do
    seconds_until_reset = RelativeTime.seconds_until(reset_at, snapshot_at)

    if DateTime.compare(reset_at, snapshot_at) == :gt do
      "in #{Formatting.format_reset_duration(seconds_until_reset)}"
    else
      "due"
    end
  end

  defp quota_reset_title(%DateTime{} = reset_at, datetime_preferences) do
    "resets #{DateTimeDisplay.format_datetime(reset_at, datetime_preferences)}"
  end

  defp remaining_percent_from_used(%Decimal{} = used_percent) do
    Decimal.sub(Decimal.new(100), used_percent)
  end

  defp decimal_clamp_percent(%Decimal{} = value) do
    value
    |> decimal_non_negative()
    |> Decimal.min(Decimal.new(100))
  end

  defp decimal_non_negative(%Decimal{} = value), do: Decimal.max(value, Decimal.new(0))
end
