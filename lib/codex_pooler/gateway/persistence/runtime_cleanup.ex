defmodule CodexPooler.Gateway.Persistence.RuntimeCleanup do
  @moduledoc """
  Cleanup helpers for expired gateway runtime persistence records.
  """

  import Ecto.Query

  alias CodexPooler.Gateway.Payloads.RequestOptions

  alias CodexPooler.Gateway.Persistence.{
    BridgeOwnerLease,
    BridgeSessionAlias,
    CodexSession,
    CodexTurn,
    IdempotencyKey
  }

  alias CodexPooler.Gateway.Persistence.StatusVocabulary.OwnerLease, as: OwnerLeaseStatus
  alias CodexPooler.Gateway.Runtime.Finalization.Interruption
  alias CodexPooler.Accounting.Request
  alias CodexPooler.Repo

  @completed_request_statuses ~w(succeeded failed rejected cancelled)
  @request_history_retention_days 90
  @request_history_cleanup_batch_size 1_000
  @owner_lease_active OwnerLeaseStatus.active_status()

  @type request_ref :: Ecto.UUID.t() | %{required(:id) => Ecto.UUID.t()}
  @type attempt_ref :: Ecto.UUID.t() | %{required(:id) => Ecto.UUID.t()} | nil

  @spec cleanup_expired_runtime_state(DateTime.t()) :: {:ok, map()} | {:error, term()}
  def cleanup_expired_runtime_state(now \\ now()) do
    with {:ok, recovered_summary} <- recover_expired_owner_runtime_state(now),
         {:ok, cleanup_summary} <- cleanup_expired(now) do
      {pruned_requests, _} = prune_completed_request_history(now)

      {:ok,
       cleanup_summary
       |> Map.merge(recovered_summary)
       |> Map.put(:pruned_request_history, pruned_requests)}
    end
  end

  @spec active_runtime_request?(request_ref(), DateTime.t()) :: boolean()
  def active_runtime_request?(%{id: request_id}, %DateTime{} = now) do
    active_runtime_request?(request_id, now)
  end

  def active_runtime_request?(request_id, %DateTime{} = now) when is_binary(request_id) do
    Repo.exists?(
      from turn in CodexTurn,
        join: session in CodexSession,
        on: session.id == turn.codex_session_id,
        left_join: lease in BridgeOwnerLease,
        on:
          lease.codex_session_id == session.id and
            lease.status == ^@owner_lease_active and lease.expires_at > ^now,
        where:
          turn.request_id == ^request_id and turn.status == ^CodexTurn.in_progress_status() and
            (session.owner_lease_expires_at > ^now or not is_nil(lease.id))
    )
  end

  def active_runtime_request?(_request_ref, %DateTime{}), do: false

  @spec recover_stale_request_turn(request_ref(), attempt_ref(), keyword()) :: :ok
  def recover_stale_request_turn(request_ref, attempt_ref, opts) when is_list(opts) do
    request_id = ref_id(request_ref)
    final_attempt_id = ref_id(attempt_ref)
    now = opts |> Keyword.fetch!(:now) |> DateTime.truncate(:microsecond)
    error_code = Keyword.fetch!(opts, :error_code)

    CodexTurn
    |> where(
      [turn],
      turn.request_id == ^request_id and turn.status == ^CodexTurn.in_progress_status()
    )
    |> Repo.update_all(
      set: [
        status: CodexTurn.interrupted_status(),
        error_code: error_code,
        final_attempt_id: final_attempt_id,
        completed_at: now,
        updated_at: now
      ]
    )

    :ok
  end

  @spec cleanup_expired(DateTime.t()) :: {:ok, map()} | {:error, term()}
  def cleanup_expired(now \\ now()) do
    now = DateTime.truncate(now, :microsecond)
    active_alias_status = BridgeSessionAlias.active_status()
    active_lease_status = BridgeOwnerLease.active_status()
    expired_alias_status = BridgeSessionAlias.expired_status()
    expired_lease_status = BridgeOwnerLease.expired_status()
    expired_idempotency_status = IdempotencyKey.expired_status()
    expirable_idempotency_statuses = IdempotencyKey.expirable_statuses()

    Repo.transaction(fn ->
      {expired_aliases, _} =
        BridgeSessionAlias
        |> where(
          [alias_record],
          alias_record.status == ^active_alias_status and alias_record.expires_at <= ^now
        )
        |> Repo.update_all(set: [status: expired_alias_status, updated_at: now])

      {expired_leases, _} =
        BridgeOwnerLease
        |> where([lease], lease.status == ^active_lease_status and lease.expires_at <= ^now)
        |> Repo.update_all(set: [status: expired_lease_status, released_at: now, updated_at: now])

      {expired_idempotency_keys, _} =
        IdempotencyKey
        |> where(
          [key],
          key.status in ^expirable_idempotency_statuses and key.expires_at <= ^now
        )
        |> Repo.update_all(set: [status: expired_idempotency_status, updated_at: now])

      %{
        expired_aliases: expired_aliases,
        expired_owner_leases: expired_leases,
        expired_idempotency_keys: expired_idempotency_keys
      }
    end)
  end

  # ponytail: prunes 1000 rows per 15-min run (~96k/day) outside the cleanup
  # transaction; a large first-run backlog drains over several runs rather than
  # at once. Raise the batch/cadence only if retention can't keep up.
  @spec prune_completed_request_history(DateTime.t()) :: {non_neg_integer(), nil}
  defp prune_completed_request_history(%DateTime{} = now) do
    cutoff = DateTime.add(now, -@request_history_retention_days, :day)

    expired_request_ids =
      from request in Request,
        where: request.status in ^@completed_request_statuses and request.completed_at < ^cutoff,
        order_by: [asc: request.completed_at],
        limit: @request_history_cleanup_batch_size,
        select: request.id

    from(request in Request, where: request.id in subquery(expired_request_ids))
    |> Repo.delete_all()
  end

  defp recover_expired_owner_runtime_state(%DateTime{} = now) do
    now = DateTime.truncate(now, :microsecond)

    now
    |> expired_owner_sessions_with_active_turns()
    |> Enum.reduce_while({:ok, 0}, &recover_expired_owner_session/2)
    |> case do
      {:ok, recovered_count} -> {:ok, %{expired_owner_sessions_recovered: recovered_count}}
      {:error, reason} -> {:error, reason}
    end
  end

  defp recover_expired_owner_session(session_id, {:ok, recovered_count}) do
    case Interruption.recover_owner_lifecycle_leftovers(
           session_id,
           :owner_unavailable,
           RequestOptions.for_websocket(%{})
         ) do
      {:ok, _result} -> {:cont, {:ok, recovered_count + 1}}
      {:error, reason} -> {:halt, {:error, reason}}
    end
  end

  defp ref_id(nil), do: nil
  defp ref_id(%{id: id}), do: id
  defp ref_id(id) when is_binary(id), do: id

  defp expired_owner_sessions_with_active_turns(%DateTime{} = now) do
    Repo.all(
      from session in CodexSession,
        join: lease in BridgeOwnerLease,
        on:
          lease.codex_session_id == session.id and
            lease.status == ^BridgeOwnerLease.active_status() and
            lease.expires_at <= ^now,
        join: turn in CodexTurn,
        on:
          turn.codex_session_id == session.id and
            turn.status == ^CodexTurn.in_progress_status(),
        distinct: session.id,
        select: session.id
    )
  end

  defp now, do: DateTime.utc_now() |> DateTime.truncate(:microsecond)
end
