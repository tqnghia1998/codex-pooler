defmodule CodexPoolerWeb.Admin.UpstreamCompassImport do
  @moduledoc false

  import Phoenix.Component, only: [to_form: 2]

  @spec empty_form() :: Phoenix.HTML.Form.t()
  def empty_form do
    form_for_params(%{"pool_id" => "", "project_id" => "", "project_key" => ""})
  end

  @spec form_for_pool(String.t() | nil) :: Phoenix.HTML.Form.t()
  def form_for_pool(pool_id) do
    form_for_params(%{"pool_id" => pool_id || "", "project_id" => "", "project_key" => ""})
  end

  @spec form_for_params(map()) :: Phoenix.HTML.Form.t()
  def form_for_params(params) when is_map(params) do
    params
    |> Map.take(["pool_id", "project_id", "project_key"])
    |> Map.put_new("pool_id", "")
    |> Map.put_new("project_id", "")
    |> Map.put_new("project_key", "")
    |> to_form(as: :compass_import)
  end

  def form_for_params(_params), do: empty_form()
end
