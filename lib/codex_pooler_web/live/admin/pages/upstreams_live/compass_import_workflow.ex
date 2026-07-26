defmodule CodexPoolerWeb.Admin.UpstreamsLive.CompassImportWorkflow do
  @moduledoc false

  import Phoenix.Component, only: [assign: 2, assign: 3, to_form: 2]
  import Phoenix.LiveView, only: [put_flash: 3]

  alias CodexPooler.Upstreams
  alias CodexPoolerWeb.Admin.UpstreamCompassImport
  alias CodexPoolerWeb.Admin.UpstreamsLive.WorkflowError

  @spec form_for_open([map()], map()) :: Phoenix.HTML.Form.t()
  def form_for_open(pools, %{"pool-id" => pool_id}) do
    case selected_pool(pools, pool_id) do
      nil -> UpstreamCompassImport.empty_form()
      _pool -> UpstreamCompassImport.form_for_pool(pool_id)
    end
  end

  def form_for_open(_pools, _params), do: UpstreamCompassImport.empty_form()

  @spec close(Phoenix.LiveView.Socket.t()) :: Phoenix.LiveView.Socket.t()
  def close(socket) do
    assign(socket,
      importing_compass: false,
      compass_form: UpstreamCompassImport.empty_form()
    )
  end

  @spec validate(Phoenix.LiveView.Socket.t(), map()) :: Phoenix.LiveView.Socket.t()
  def validate(socket, compass_params) do
    assign(socket, :compass_form, UpstreamCompassImport.form_for_params(compass_params))
  end

  @spec import(Phoenix.LiveView.Socket.t(), map(), map() | nil, (Phoenix.LiveView.Socket.t() ->
                                                                   Phoenix.LiveView.Socket.t())) ::
          Phoenix.LiveView.Socket.t()
  def import(socket, compass_params, pool, reload_fun) when is_function(reload_fun, 1) do
    case Upstreams.import_compass_project_key(socket.assigns.current_scope, pool, compass_params) do
      {:ok, %{status: :created}} ->
        import_success(socket, "Compass project imported", reload_fun)

      {:ok, %{status: :existing}} ->
        import_success(
          socket,
          "Compass project matched an existing account; key updated",
          reload_fun
        )

      {:error, %Ecto.Changeset{} = changeset} ->
        socket
        |> put_flash(:error, "Compass project could not be imported")
        |> assign(importing_compass: true, compass_form: to_form(changeset, as: :compass_import))

      {:error, reason} ->
        socket
        |> put_flash(:error, WorkflowError.message(reason))
        |> assign(
          importing_compass: true,
          compass_form: UpstreamCompassImport.form_for_params(compass_params)
        )
    end
  end

  defp import_success(socket, message, reload_fun) do
    socket
    |> put_flash(:info, message)
    |> assign(importing_compass: false, compass_form: UpstreamCompassImport.empty_form())
    |> reload_fun.()
  end

  defp selected_pool(pools, pool_id) when is_binary(pool_id),
    do: Enum.find(pools, &(&1.id == pool_id))

  defp selected_pool(_pools, _pool_id), do: nil
end
