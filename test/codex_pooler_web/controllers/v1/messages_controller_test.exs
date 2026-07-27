defmodule CodexPoolerWeb.V1.MessagesControllerTest do
  use CodexPoolerWeb.ConnCase, async: false

  import CodexPoolerWeb.Runtime.BackendCodexTestSupport,
    only: [auth: 2, gateway_setup: 2, start_upstream: 1]

  alias CodexPooler.FakeUpstream
  alias CodexPooler.Repo

  @model "claude-sonnet-4-20250514"
  @anthropic_response %{
    "id" => "msg_01ABC123",
    "type" => "message",
    "role" => "assistant",
    "content" => [%{"type" => "text", "text" => "Hello from Claude"}],
    "model" => @model,
    "stop_reason" => "end_turn",
    "usage" => %{"input_tokens" => 10, "output_tokens" => 5}
  }

  test "POST /v1/messages sends Compass requests directly to /messages", %{conn: conn} do
    {setup, upstream} = compass_setup(@anthropic_response, @model)
    payload = message_payload(@model)

    response =
      conn
      |> auth(setup)
      |> put_req_header("anthropic-version", "2023-06-01")
      |> put_req_header("anthropic-beta", "interleaved-thinking-2025-05-14")
      |> post("/v1/messages", payload)

    assert %{"id" => "msg_01ABC123", "type" => "message"} = json_response(response, 200)
    assert [captured] = FakeUpstream.requests(upstream)
    assert captured.path == "/messages"
    assert captured.json == Map.put(payload, "model", setup.model.upstream_model_id)

    headers = Map.new(captured.headers)
    refute Map.has_key?(headers, "chatgpt-account-id")
    refute Map.has_key?(headers, "openai-beta")
    refute Map.has_key?(headers, "originator")
    assert headers["anthropic-version"] == "2023-06-01"
    assert headers["anthropic-beta"] == "interleaved-thinking-2025-05-14"
  end

  test "POST /v1/messages accepts Anthropic x-api-key authentication", %{conn: conn} do
    {setup, upstream} = compass_setup(@anthropic_response, @model)

    response =
      conn
      |> put_req_header("x-api-key", setup.raw_key)
      |> put_req_header("anthropic-version", "2023-06-01")
      |> post("/v1/messages", message_payload(@model))

    assert %{"id" => "msg_01ABC123"} = json_response(response, 200)
    assert [_captured] = FakeUpstream.requests(upstream)
  end

  test "POST /v1/messages rejects requests without model", %{conn: conn} do
    {setup, _upstream} = compass_setup(%{"id" => "unused"}, "gpt-test-model")

    response =
      conn
      |> auth(setup)
      |> post("/v1/messages", %{"messages" => [%{"role" => "user", "content" => "Hi"}]})

    assert %{"error" => %{"code" => "invalid_request", "param" => "model"}} =
             json_response(response, 400)
  end

  test "POST /v1/messages preserves valid Anthropic 4xx errors", %{conn: conn} do
    anthropic_error = %{
      "type" => "error",
      "error" => %{
        "type" => "invalid_request_error",
        "message" => "messages: at least one message is required"
      }
    }

    {setup, _upstream} = compass_setup(anthropic_error, @model, 400)

    response =
      conn
      |> auth(setup)
      |> put_req_header("anthropic-version", "2023-06-01")
      |> post("/v1/messages", Map.put(message_payload(@model), "stream", true))

    assert json_response(response, 400) == anthropic_error
  end

  test "POST /v1/messages redacts malformed 4xx and upstream 5xx errors", %{conn: conn} do
    for {upstream_error, status, secret} <- [
          {%{"secret" => "malformed Compass detail"}, 400, "malformed Compass detail"},
          {%{
             "type" => "error",
             "error" => %{"type" => "api_error", "message" => "internal Compass secret"}
           }, 500, "internal Compass secret"}
        ] do
      {setup, _upstream} = compass_setup(upstream_error, @model, status)

      response =
        conn
        |> recycle()
        |> auth(setup)
        |> put_req_header("anthropic-version", "2023-06-01")
        |> post("/v1/messages", Map.put(message_payload(@model), "stream", true))

      body = json_response(response, status)
      assert body["error"]["message"] == "upstream request failed"
      refute inspect(body) =~ secret
    end
  end

  test "POST /v1/messages adapts legacy thinking only for Claude 4.7 and later", %{conn: conn} do
    for {model_id, expected} <- [
          {"claude-sonnet-5", %{"type" => "adaptive"}},
          {"claude-opus-4-7", %{"type" => "adaptive"}},
          {@model, %{"type" => "enabled", "budget_tokens" => 2048}}
        ] do
      {setup, upstream} = compass_setup(@anthropic_response, model_id)

      response =
        conn
        |> recycle()
        |> auth(setup)
        |> put_req_header("anthropic-version", "2023-06-01")
        |> post(
          "/v1/messages",
          message_payload(model_id, %{
            "thinking" => %{"type" => "enabled", "budget_tokens" => 2048}
          })
        )

      assert %{"id" => "msg_01ABC123"} = json_response(response, 200)
      assert [captured] = FakeUpstream.requests(upstream)
      assert captured.json["thinking"] == expected
    end
  end

  defp compass_setup(response, model_id, status \\ 200) do
    upstream = start_upstream(FakeUpstream.json_response(response, status))
    setup = gateway_setup(upstream, exposed_model_id: model_id, upstream_model_id: model_id)

    for record <- [setup.identity, setup.assignment] do
      record
      |> Ecto.Changeset.change(metadata: Map.put(record.metadata, "provider", "compass"))
      |> Repo.update!()
    end

    {setup, upstream}
  end

  defp message_payload(model_id, extra \\ %{}) do
    Map.merge(
      %{
        "model" => model_id,
        "max_tokens" => 1024,
        "messages" => [%{"role" => "user", "content" => "Hello"}]
      },
      extra
    )
  end
end
