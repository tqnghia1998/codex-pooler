defmodule CodexPooler.Jobs.TokenRefreshEnqueueWorker do
  @moduledoc """
  Periodically enqueues token refresh recovery jobs for eligible upstream identities.
  """

  use Oban.Worker,
    queue: :jobs,
    max_attempts: 1,
    tags: ["token_refresh_enqueue"],
    unique: [
      fields: [:worker, :queue],
      states: :incomplete,
      period: {60, :minutes}
    ]

  alias CodexPooler.Jobs

  @impl Oban.Worker
  def timeout(%Oban.Job{}), do: :timer.seconds(30)

  @impl Oban.Worker
  def perform(%Oban.Job{}) do
    case enqueue_scheduled_token_refreshes(trigger_kind: "scheduled") do
      {:ok, %{errors: []}} -> :ok
      {:ok, %{errors: errors}} -> {:error, {:enqueue_failed, length(errors)}}
    end
  end

  defp enqueue_scheduled_token_refreshes(opts) do
    :codex_pooler
    |> Application.get_env(__MODULE__, [])
    |> Keyword.get(:enqueue_fun, &Jobs.enqueue_scheduled_token_refreshes/1)
    |> case do
      enqueue_fun when is_function(enqueue_fun, 1) -> enqueue_fun.(opts)
      _invalid -> Jobs.enqueue_scheduled_token_refreshes(opts)
    end
  end
end
