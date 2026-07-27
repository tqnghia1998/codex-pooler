defmodule CodexPooler.Repo.Migrations.AllowV1MessagesRequestLogs do
  use Ecto.Migration

  def change do
    execute(
      """
      ALTER TABLE public.requests
      DROP CONSTRAINT IF EXISTS requests_endpoint_check,
      ADD CONSTRAINT requests_endpoint_check CHECK ((endpoint = ANY (ARRAY[
        '/backend-api/codex/models'::text,
        '/backend-api/codex/responses'::text,
        '/backend-api/codex/responses/compact'::text,
        '/backend-api/codex/images/generations'::text,
        '/backend-api/codex/images/edits'::text,
        '/backend-api/transcribe'::text,
        '/backend-api/files'::text,
        '/backend-api/files/uploaded'::text,
        '/api/codex/usage'::text,
        '/wham/usage'::text,
        '/backend-api/wham/usage'::text,
        '/v1/models'::text,
        '/v1/messages'::text,
        '/v1/responses'::text,
        '/v1/usage'::text,
        '/v1/files'::text,
        '/v1/files/content'::text,
        '/v1/files/delete'::text
      ]))) NOT VALID;
      """,
      """
      ALTER TABLE public.requests
      DROP CONSTRAINT IF EXISTS requests_endpoint_check,
      ADD CONSTRAINT requests_endpoint_check CHECK ((endpoint = ANY (ARRAY[
        '/backend-api/codex/models'::text,
        '/backend-api/codex/responses'::text,
        '/backend-api/codex/responses/compact'::text,
        '/backend-api/codex/images/generations'::text,
        '/backend-api/codex/images/edits'::text,
        '/backend-api/transcribe'::text,
        '/backend-api/files'::text,
        '/backend-api/files/uploaded'::text,
        '/api/codex/usage'::text,
        '/wham/usage'::text,
        '/backend-api/wham/usage'::text,
        '/v1/models'::text,
        '/v1/responses'::text,
        '/v1/usage'::text,
        '/v1/files'::text,
        '/v1/files/content'::text,
        '/v1/files/delete'::text
      ])));
      """
    )
  end
end
