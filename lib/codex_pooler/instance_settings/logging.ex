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
  # "error" (and any other/legacy value) keeps warnings audible: upstream's
  # WebSocket/streaming diagnostics log at :warning, and :error would silently
  # swallow them since Logger orders debug < info < warning < error.
  defp level(_mode), do: :warning
end
