defmodule CodexPoolerWeb.PublicGatewayResult do
  @moduledoc false

  import Phoenix.Controller, only: [json: 2]
  import Plug.Conn, only: [put_status: 2]

  alias CodexPooler.Gateway.Contracts
  alias CodexPooler.Gateway.OpenAICompatibility.PublicResponse
  alias CodexPoolerWeb.GatewayControllerHelpers, as: GatewayHelpers

  @type success_normalizer :: (map() -> map())
  @type gateway_call_result ::
          {:ok, Contracts.gateway_result()} | {:error, Contracts.gateway_error()}

  @spec send(Plug.Conn.t(), gateway_call_result(), success_normalizer(), keyword()) ::
          Plug.Conn.t()
  def send(conn, result, success_normalizer, opts \\ [])

  def send(conn, {:ok, %{raw_body: body, status: status} = result}, success_normalizer, opts)
      when status >= 400 do
    if Keyword.get(opts, :passthrough_upstream_errors?, false) and
         anthropic_client_error?(status, body) do
      GatewayHelpers.send_gateway_result(conn, result)
    else
      send_normalized_raw_body(conn, result, success_normalizer)
    end
  end

  def send(conn, {:ok, %{stream: _stream} = result}, _success_normalizer, _opts) do
    GatewayHelpers.send_gateway_result(conn, %{
      result
      | headers: PublicResponse.stream_headers(GatewayHelpers.result_headers(result))
    })
  end

  def send(conn, {:ok, %{raw_body: _body} = result}, success_normalizer, _opts),
    do: send_normalized_raw_body(conn, result, success_normalizer)

  def send(conn, {:ok, %{body: _body} = result}, _success_normalizer, _opts),
    do: GatewayHelpers.send_gateway_result(conn, result)

  def send(conn, {:error, %{status: status} = reason}, _success_normalizer, _opts) do
    if PublicResponse.redacted_gateway_error?(reason) do
      conn
      |> put_status(status)
      |> json(%{"error" => PublicResponse.normalize_error(reason, status: status)})
    else
      GatewayHelpers.send_error(conn, reason)
    end
  end

  def send(conn, {:error, reason}, _success_normalizer, _opts),
    do: GatewayHelpers.send_error(conn, reason)

  defp anthropic_client_error?(status, body) when status in 400..499 and is_binary(body) do
    case Jason.decode(body) do
      {:ok,
       %{
         "type" => "error",
         "error" => %{"type" => type, "message" => message}
       }}
      when is_binary(type) and is_binary(message) ->
        true

      _invalid ->
        false
    end
  end

  defp anthropic_client_error?(_status, _body), do: false

  defp send_normalized_raw_body(
         conn,
         %{raw_body: body, status: status} = result,
         success_normalizer
       ) do
    case PublicResponse.normalize_raw_body(status, body, success_normalizer) do
      {:ok, normalized} ->
        conn
        |> put_status(status)
        |> json(normalized)

      :passthrough ->
        GatewayHelpers.send_gateway_result(conn, result)
    end
  end
end
