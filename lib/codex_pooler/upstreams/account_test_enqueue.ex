defmodule CodexPooler.Upstreams.AccountTestEnqueue do
  @moduledoc false

  alias CodexPooler.Accounts.Scope
  alias CodexPooler.Upstreams.Assignments
  alias CodexPooler.Upstreams.Assignments.PoolAssignments
  alias CodexPooler.Upstreams.Lifecycle.AccountLifecycle
  alias CodexPooler.Upstreams.Schemas.PoolUpstreamAssignment

  @spec test_for_scope(Scope.t(), Ecto.UUID.t()) ::
          {:ok, map()} | {:error, map() | Ecto.Changeset.t()}
  def test_for_scope(%Scope{} = scope, identity_id) do
    with {:ok, identity} <- AccountLifecycle.authorize(scope, identity_id),
         %PoolUpstreamAssignment{} = assignment <- active_assignment(identity.id),
         {:ok, result} <-
           Assignments.reconcile_pool_account(assignment.pool_id, assignment,
             record_summary?: false,
             allow_persisted_fallback?: false
           ) do
      {:ok, %{result: result, identity: identity, assignment: assignment}}
    else
      nil ->
        {:error,
         %{code: :active_assignment_not_found, message: "account has no active Pool assignment"}}

      {:error, _reason} = error ->
        error
    end
  end

  def test_for_scope(_scope, _identity_id),
    do: {:error, %{code: :invalid_request, message: "user scope is required"}}

  defp active_assignment(identity_id) do
    identity_id
    |> PoolAssignments.list_pool_assignments_for_identity()
    |> Enum.find(&(&1.status == PoolUpstreamAssignment.active_status()))
  end
end
