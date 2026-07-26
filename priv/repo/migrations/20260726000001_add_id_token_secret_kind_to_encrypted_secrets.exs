defmodule CodexPooler.Repo.Migrations.AddIdTokenSecretKindToEncryptedSecrets do
  use Ecto.Migration

  @constraint "encrypted_secrets_secret_kind_check"
  @existing_kinds ~w(access_token refresh_token device_code web_session api_key other)
  @new_kinds ~w(access_token refresh_token id_token device_code web_session api_key other)

  def up do
    replace_secret_kind_constraint(@new_kinds)
  end

  def down do
    execute("DELETE FROM public.encrypted_secrets WHERE secret_kind = 'id_token'")
    replace_secret_kind_constraint(@existing_kinds)
  end

  defp replace_secret_kind_constraint(kinds) do
    execute("ALTER TABLE ONLY public.encrypted_secrets DROP CONSTRAINT IF EXISTS #{@constraint}")

    values = Enum.map_join(kinds, ", ", &"'#{&1}'::text")

    execute("""
    ALTER TABLE ONLY public.encrypted_secrets
    ADD CONSTRAINT #{@constraint} CHECK (secret_kind = ANY (ARRAY[#{values}]))
    """)
  end
end
