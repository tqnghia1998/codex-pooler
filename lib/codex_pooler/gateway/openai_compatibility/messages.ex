defmodule CodexPooler.Gateway.OpenAICompatibility.Messages do
  @moduledoc false

  alias CodexPooler.Gateway.OpenAICompatibility.Error
  alias CodexPooler.Gateway.Payloads.RequestOptions

  @endpoint "/v1/messages"

  @spec coerce(map(), map() | keyword()) ::
          {:ok,
           %{
             endpoint: String.t(),
             payload: map(),
             request_options: RequestOptions.t()
           }}
          | {:error, Error.reason()}
  def coerce(%{"model" => model} = payload, opts) when is_binary(model) and model != "" do
    request_options =
      opts
      |> Map.new()
      |> Map.put(:upstream_endpoint, @endpoint)
      |> Map.put(:direct_upstream?, true)
      |> Map.put(:direct_payload, payload)
      |> then(&RequestOptions.build(&1, @endpoint, payload))

    {:ok, %{endpoint: @endpoint, payload: payload, request_options: request_options}}
  end

  def coerce(_payload, _opts) do
    {:error, Error.invalid_request("model is required", "model")}
  end
end
