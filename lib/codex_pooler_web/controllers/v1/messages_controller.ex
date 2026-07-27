defmodule CodexPoolerWeb.V1.MessagesController do
  use CodexPoolerWeb, :controller

  alias CodexPooler.Gateway.OpenAICompatibility.Messages
  alias CodexPoolerWeb.{GatewayControllerHelpers, PublicGatewayDispatch}

  def create(conn, params) do
    PublicGatewayDispatch.coerced(
      conn,
      fn -> Messages.coerce(params, GatewayControllerHelpers.request_opts(conn)) end,
      fn decoded, _coerced -> decoded end,
      passthrough_upstream_errors?: true
    )
  end
end
