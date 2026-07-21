defmodule CodexPooler.InstanceSettings.Logging do
  @moduledoc false

  alias CodexPooler.InstanceSettings.Settings

  @spec apply(Settings.t()) :: :ok
  def apply(%Settings{gateway: %{logging_mode: mode}}) do
    Logger.configure(level: level(mode))
  end

  @spec all?() :: boolean()
  def all? do
    CodexPooler.InstanceSettings.current().gateway.logging_mode == "all"
  end

  defp level("off"), do: :none
  defp level("all"), do: :info
  defp level(_error), do: :error
end
