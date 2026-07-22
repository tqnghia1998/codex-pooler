defmodule CodexPoolerWeb.Admin.UpstreamsLive.SpendCapWorkflow do
  @moduledoc false

  import Phoenix.Component, only: [assign: 2, assign: 3, to_form: 2]
  import Phoenix.LiveView, only: [put_flash: 3]

  alias CodexPooler.Upstreams
  alias CodexPooler.Upstreams.Quota.Windows, as: QuotaWindows
  alias CodexPooler.Upstreams.Schemas.UpstreamIdentity
  alias CodexPoolerWeb.Admin.UpstreamsLive.WorkflowError

  @credits_per_dollar Decimal.new(25)

  @spec open(Phoenix.LiveView.Socket.t(), Ecto.UUID.t()) :: Phoenix.LiveView.Socket.t()
  def open(socket, identity_id) do
    case find_account(socket, identity_id) do
      nil ->
        put_flash(socket, :error, "Upstream account was not found")

      account ->
        identity = account.identity
        current_value = usd_value(identity.spend_cap_credits || 0)

        assign(socket,
          editing_spend_cap: account,
          spend_cap_form: form(identity, %{"spend_cap_credits" => current_value}, nil)
        )
    end
  end

  @spec open_bulk(Phoenix.LiveView.Socket.t()) :: Phoenix.LiveView.Socket.t()
  @default_bulk_rules [
    {1000, 100},
    {500, 50},
    {200, 20},
    {100, 10},
    {0, 5}
  ]

  def open_bulk(socket) do
    rules =
      @default_bulk_rules
      |> Enum.with_index()
      |> Map.new(fn {{quota, cap}, index} ->
        {Integer.to_string(index), %{"monthly_quota" => quota, "spend_cap" => cap}}
      end)

    assign(socket,
      editing_spend_cap: %{bulk: true},
      spend_cap_form: bulk_form(%{"rules" => rules})
    )
  end

  # ponytail: rule keys are always the rendered 0..N-1 sequence (see
  # Phoenix.HTML.FormData for Map), so the next key is just the current count.
  def add_bulk_rule(socket) do
    params = current_bulk_params(socket)
    rules = params["rules"] || %{}
    params = put_in(params, ["rules", Integer.to_string(map_size(rules))], empty_rule())
    assign(socket, :spend_cap_form, bulk_form(params))
  end

  # ponytail: rendered rule_form.index is a rendering position, not the map
  # key, so removal must reorder by position then renumber keys back to a
  # contiguous 0..N-1 range (matching add_bulk_rule's assumption) instead of
  # deleting the map entry at `id` directly.
  def remove_bulk_rule(socket, id) do
    params = current_bulk_params(socket)
    rules = params["rules"] || %{}

    case Integer.parse(id) do
      {index, ""} when index >= 0 and index < map_size(rules) ->
        remaining =
          rules
          |> Enum.sort_by(fn {key, _value} -> String.to_integer(key) end)
          |> Enum.map(fn {_key, value} -> value end)
          |> List.delete_at(index)
          |> Enum.with_index()
          |> Map.new(fn {value, idx} -> {Integer.to_string(idx), value} end)

        assign(socket, :spend_cap_form, bulk_form(Map.put(params, "rules", remaining)))

      _invalid ->
        socket
    end
  end

  @spec close(Phoenix.LiveView.Socket.t()) :: Phoenix.LiveView.Socket.t()
  def close(socket),
    do: assign(socket, editing_spend_cap: nil, spend_cap_form: nil)

  @spec validate(
          Phoenix.LiveView.Socket.t(),
          UpstreamIdentity.t(),
          map()
        ) :: Phoenix.LiveView.Socket.t()
  def validate(socket, %UpstreamIdentity{} = identity, params) do
    changeset = validated_changeset(socket, identity, params)
    assign(socket, :spend_cap_form, to_form(changeset, as: :spend_cap))
  end

  def validate_bulk(socket, params) do
    assign(socket, :spend_cap_form, bulk_form(params))
  end

  @spec save(
          Phoenix.LiveView.Socket.t(),
          UpstreamIdentity.t(),
          map(),
          (Phoenix.LiveView.Socket.t() -> Phoenix.LiveView.Socket.t()),
          (Phoenix.LiveView.Socket.t() -> Phoenix.LiveView.Socket.t())
        ) :: Phoenix.LiveView.Socket.t()
  def save(socket, %UpstreamIdentity{} = identity, params, close_fun, reload_fun) do
    changeset = validated_changeset(socket, identity, params)

    if changeset.valid? do
      attrs = %{
        spend_cap_credits: changeset.changes[:spend_cap_credits] || identity.spend_cap_credits
      }

      case Upstreams.update_spend_cap_for_scope(
             socket.assigns.current_scope,
             identity.id,
             attrs
           ) do
        {:ok, _result} ->
          socket
          |> put_flash(:info, "Spend cap updated")
          |> close_fun.()
          |> reload_fun.()

        {:error, %Ecto.Changeset{} = changeset} ->
          assign(socket, :spend_cap_form, to_form(changeset, as: :spend_cap))

        {:error, reason} ->
          put_flash(socket, :error, WorkflowError.message(reason))
      end
    else
      assign(socket, :spend_cap_form, to_form(changeset, as: :spend_cap))
    end
  end

  def save_bulk(socket, params, close_fun, reload_fun) do
    case parse_rules(params) do
      {:ok, rules} ->
        accounts = matching_bulk_accounts(socket, rules)

        case Enum.reduce_while(accounts, :ok, fn {identity, cap}, :ok ->
               attrs = %{spend_cap_credits: dollars_to_credits(cap)}

               case Upstreams.update_spend_cap_for_scope(
                      socket.assigns.current_scope,
                      identity.id,
                      attrs
                    ) do
                 {:ok, _result} -> {:cont, :ok}
                 {:error, reason} -> {:halt, {:error, reason}}
               end
             end) do
          :ok ->
            socket
            |> put_flash(:info, "Spend cap updated for #{length(accounts)} accounts")
            |> close_fun.()
            |> reload_fun.()

          {:error, reason} ->
            put_flash(socket, :error, WorkflowError.message(reason))
        end

      {:error, errors} ->
        assign(socket, :spend_cap_form, bulk_form(params, errors))
    end
  end

  defp validated_changeset(_socket, identity, params),
    do: changeset(identity, credit_params(params), :validate)

  defp current_bulk_params(socket), do: socket.assigns.spend_cap_form.params

  defp bulk_form(params, errors \\ []),
    do: to_form(params, as: :spend_cap, errors: errors)

  defp parse_rules(%{"rules" => rules}) when is_map(rules) and map_size(rules) > 0 do
    parsed =
      rules
      |> Map.values()
      |> Enum.map(fn rule ->
        with {quota, ""} <- Decimal.parse(to_string(rule["monthly_quota"] || "")),
             {cap, ""} <- Decimal.parse(to_string(rule["spend_cap"] || "")),
             true <- Decimal.compare(quota, 0) != :lt,
             true <- Decimal.compare(cap, 0) != :lt do
          {:ok, {quota, cap}}
        else
          _invalid -> :error
        end
      end)

    if Enum.all?(parsed, &match?({:ok, _}, &1)) do
      {:ok, Enum.map(parsed, fn {:ok, rule} -> rule end)}
    else
      {:error, rules: {"Enter non-negative numbers for every quota and cap", []}}
    end
  end

  defp parse_rules(_params), do: {:error, rules: {"Add at least one rule", []}}

  defp matching_bulk_accounts(socket, rules) do
    identities = Upstreams.list_visible_upstream_identities(socket.assigns.current_scope)

    windows =
      identities
      |> Enum.map(& &1.id)
      |> QuotaWindows.list_quota_windows_by_identity_ids()

    Enum.flat_map(identities, fn identity ->
      with %Decimal{} = quota_left <- monthly_quota_left(windows[identity.id] || []),
           {_threshold, cap} <-
             rules
             |> Enum.filter(fn {threshold, _cap} ->
               Decimal.compare(quota_left, threshold) == :gt
             end)
             |> Enum.max_by(
               fn {threshold, _cap} -> threshold end,
               fn left, right -> Decimal.compare(left, right) != :lt end,
               fn -> nil end
             ) do
        [{identity, cap}]
      else
        _no_match -> []
      end
    end)
  end

  defp monthly_quota_left(windows) do
    Enum.find_value(windows, fn
      %{quota_key: "spend_control", metadata: metadata} when is_map(metadata) ->
        with {quota, ""} <- Decimal.parse(to_string(metadata["spend_cap"] || "")),
             {used, ""} <- Decimal.parse(to_string(metadata["spend_used"] || "")) do
          quota
          |> Decimal.sub(used)
          |> Decimal.max(Decimal.new(0))
          |> Decimal.div(@credits_per_dollar)
        else
          _invalid -> nil
        end

      _window ->
        nil
    end)
  end

  defp dollars_to_credits(dollars) do
    dollars |> Decimal.mult(@credits_per_dollar) |> Decimal.round(0) |> Decimal.to_integer()
  end

  defp empty_rule, do: %{"monthly_quota" => "", "spend_cap" => ""}

  defp credit_params(%{"spend_cap_credits" => dollars} = params) do
    case Decimal.parse(to_string(dollars)) do
      {amount, ""} ->
        Map.put(
          params,
          "spend_cap_credits",
          amount |> Decimal.mult(@credits_per_dollar) |> Decimal.round(0) |> Decimal.to_integer()
        )

      _invalid ->
        params
    end
  end

  defp credit_params(params), do: params

  defp usd_value(credits) do
    credits
    |> Decimal.new()
    |> Decimal.div(@credits_per_dollar)
    |> Decimal.normalize()
    |> Decimal.to_string(:normal)
  end

  defp changeset(identity, attrs, action) do
    now = DateTime.utc_now() |> DateTime.truncate(:microsecond)

    identity
    |> UpstreamIdentity.changeset(Map.put(attrs, "updated_at", now))
    |> Map.put(:action, action)
  end

  defp form(identity, attrs, action) do
    identity
    |> changeset(attrs, action)
    |> to_form(as: :spend_cap)
  end

  defp find_account(socket, identity_id) do
    Enum.find(socket.assigns.upstream_accounts, &(&1.identity.id == identity_id))
  end
end
