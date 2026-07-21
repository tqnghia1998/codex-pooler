defmodule CodexPoolerWeb.Admin.UpstreamsLive.SpendCapWorkflow do
  @moduledoc false

  import Phoenix.Component, only: [assign: 2, assign: 3, to_form: 2]
  import Phoenix.LiveView, only: [put_flash: 3]

  alias CodexPooler.Upstreams
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

  @spec close(Phoenix.LiveView.Socket.t()) :: Phoenix.LiveView.Socket.t()
  def close(socket),
    do: assign(socket, editing_spend_cap: nil, spend_cap_form: nil)

  @spec validate(
          Phoenix.LiveView.Socket.t(),
          UpstreamIdentity.t(),
          map()
        ) :: Phoenix.LiveView.Socket.t()
  def validate(socket, %UpstreamIdentity{} = identity, params) do
    changeset = changeset(identity, credit_params(params), :validate)
    assign(socket, :spend_cap_form, to_form(changeset, as: :spend_cap))
  end

  @spec save(
          Phoenix.LiveView.Socket.t(),
          UpstreamIdentity.t(),
          map(),
          (Phoenix.LiveView.Socket.t() -> Phoenix.LiveView.Socket.t()),
          (Phoenix.LiveView.Socket.t() -> Phoenix.LiveView.Socket.t())
        ) :: Phoenix.LiveView.Socket.t()
  def save(socket, %UpstreamIdentity{} = identity, params, close_fun, reload_fun) do
    changeset = changeset(identity, credit_params(params), :validate)

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
