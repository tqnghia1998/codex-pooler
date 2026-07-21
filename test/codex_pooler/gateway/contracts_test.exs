defmodule CodexPooler.Gateway.ContractsTest do
  use ExUnit.Case, async: true

  alias CodexPooler.Gateway.Contracts

  @anchor_headers [
    "x-codex-previous-response-id",
    "x-codex-turn-state",
    "x-codex-window-id",
    "x-codex-session-id",
    "session-id",
    "x-session-id",
    "x-session-affinity",
    "session_id",
    "x-codex-conversation-id"
  ]

  test "hard-pinned continuation recovery contracts carry restart guidance" do
    errors = [
      Contracts.pinned_continuation_reauth_required_error(),
      Contracts.pinned_continuation_unavailable_error(%{
        "pin_mode" => "hard",
        "pin_reason" => "previous_response_id",
        "internal_reason" => "quota_exhausted"
      })
    ]

    for error <- errors do
      assert error.status == 503
      assert error.retryable == false
      assert error.requires_new_upstream_session == true

      assert error.code in [
               "pinned_continuation_reauth_required",
               "pinned_continuation_unavailable"
             ]

      assert Contracts.recovery_response_headers(error) == [
               {"x-codex-recovery-kind", "restart_with_full_context"}
             ]

      assert %{
               "retryable" => false,
               "requires_new_upstream_session" => true,
               "recovery_kind" => "restart_with_full_context",
               "recovery" => recovery
             } = Contracts.recovery_error_fields(error)

      assert recovery["kind"] == "restart_with_full_context"

      assert recovery["guidance"] ==
               "Restart with full visible context and no continuation anchors."

      assert recovery["anchor_removal"]["body"] == ["previous_response_id"]
      assert recovery["anchor_removal"]["headers"] == @anchor_headers

      assert "Full visible context means client-visible conversation state and tool results." in recovery[
               "notes"
             ]

      assert "Do not replay stored prompts or hidden server state." in recovery["notes"]
      assert Contracts.hard_pinned_continuation_recovery?(error)
    end
  end

  test "pinned spend-cap errors are retryable and do not require restart recovery" do
    error =
      Contracts.pinned_continuation_spend_cap_reached_error("Team Codex 01", %{
        "pin_mode" => "hard",
        "pin_reason" => "previous_response_id",
        "internal_reason" => "spend_cap_reached",
        "pool_upstream_assignment_id" => "assignment-1",
        "upstream_identity_id" => "identity-1"
      })

    assert error.status == 503
    assert error.code == "pinned_continuation_spend_cap_reached"
    assert error.retryable == true
    assert error.requires_new_upstream_session == false
    assert error.message =~ "Team Codex 01"
    refute error.message =~ "@"
    assert error.continuity_denial["internal_reason"] == "spend_cap_reached"
    assert Contracts.recovery_response_headers(error) == []
    assert Contracts.recovery_error_fields(error) == %{}
    refute Contracts.hard_pinned_continuation_recovery?(error)
  end

  test "recovery fields are limited to hard-pinned continuation recovery errors" do
    for error <- [
          %{status: 503, code: "session_assignment_unavailable", message: "session unavailable"},
          %{status: 400, code: "unsupported_model_capability", message: "model unsupported"},
          %{status: 400, code: "invalid_request", message: "request invalid"}
        ] do
      assert Contracts.recovery_response_headers(error) == []
      assert Contracts.recovery_error_fields(error) == %{}
      refute Contracts.pinned_continuation_reauth_required?(error)
      refute Contracts.hard_pinned_continuation_recovery?(error)
    end
  end
end
