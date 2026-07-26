defmodule CodexPooler.Upstreams.AuthJsonExport do
  @moduledoc false

  alias CodexPooler.Accounts.Scope
  alias CodexPooler.Upstreams.Assignments.PoolAssignments
  alias CodexPooler.Upstreams.Lifecycle.{AccountAudit, AccountLifecycle}
  alias CodexPooler.Upstreams.Schemas.UpstreamIdentity
  alias CodexPooler.Upstreams.Secrets

  @type lifecycle_error :: %{required(:code) => atom(), required(:message) => String.t()}
  @type identity_ref :: UpstreamIdentity.t() | Ecto.UUID.t()

  @spec export_for_scope(Scope.t(), identity_ref()) :: {:ok, map()} | {:error, lifecycle_error()}
  def export_for_scope(%Scope{} = scope, identity_or_id) do
    with {:ok, identity} <- AccountLifecycle.authorize(scope, identity_or_id),
         {:ok, tokens} <- current_tokens(identity),
         assignments = PoolAssignments.list_pool_assignments_for_identity(identity.id) do
      result = %{
        status: :ok,
        identity: identity,
        assignments: assignments,
        secret_status: Secrets.secret_status(identity),
        content: auth_json_content(identity, tokens)
      }

      {:ok, result}
      |> AccountAudit.record_change(scope, "upstream_account.auth_json_view")
    end
  end

  def export_for_scope(_scope, _identity_or_id),
    do: {:error, lifecycle_error(:invalid_request, "user scope is required")}

  defp current_tokens(%UpstreamIdentity{} = identity) do
    ~w(access_token refresh_token id_token)
    |> Enum.reduce_while({:ok, %{}}, fn kind, {:ok, tokens} ->
      case Secrets.decrypt_active_secret(identity, kind) do
        {:ok, secret} ->
          {:cont, {:ok, Map.put(tokens, kind, secret)}}

        {:error, %{code: :upstream_secret_not_found}} ->
          {:cont, {:ok, Map.put(tokens, kind, nil)}}

        {:error, reason} ->
          {:halt, {:error, reason}}
      end
    end)
  end

  defp auth_json_content(%UpstreamIdentity{} = identity, tokens) do
    %{
      "auth_mode" => auth_mode(identity),
      "OPENAI_API_KEY" => nil,
      "tokens" => %{
        "id_token" => tokens["id_token"],
        "access_token" => tokens["access_token"],
        "refresh_token" => tokens["refresh_token"],
        "account_id" => identity.chatgpt_account_id
      },
      "last_refresh" => last_refresh(identity)
    }
    |> Jason.encode!(pretty: true)
  end

  defp last_refresh(%UpstreamIdentity{} = identity) do
    [identity.last_successful_refresh_at, identity.auth_fresh_at, identity.auth_verified_at]
    |> Enum.find(&match?(%DateTime{}, &1))
    |> case do
      %DateTime{} = timestamp -> DateTime.to_iso8601(timestamp)
      nil -> nil
    end
  end

  defp auth_mode(%UpstreamIdentity{} = identity) do
    case provider(identity) do
      "compass" -> "compass"
      _ -> "chatgpt"
    end
  end

  defp provider(%UpstreamIdentity{metadata: %{} = metadata}) do
    metadata["provider"] || metadata["auth_provider"]
  end

  defp provider(_identity), do: nil

  defp lifecycle_error(code, message), do: %{code: code, message: message}
end
