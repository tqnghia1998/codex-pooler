# Fork notes for coding agents

This repository is a customized fork of `icoretech/codex-pooler`.

## Upstream baseline

- The canonical upstream remote is `upstream`, not `origin`.
- This document was last reviewed against `upstream/main` at `ce58b8cf` (`codex-pooler 0.5.8`).
- Always inspect the complete fork delta with `git diff upstream/main`; it includes committed branch changes and current working-tree changes.
- Preserve the behavior below when rebasing. Resolve conflicts intentionally rather than accepting either side wholesale.

## Upstream dashboard customizations

Primary files:

- `lib/codex_pooler_web/live/admin/pages/upstreams_live.ex`
- `lib/codex_pooler_web/live/admin/components/pages/upstreams/page_components.ex`
- `lib/codex_pooler_web/live/admin/components/pages/upstreams/account_card.ex`
- `lib/codex_pooler_web/live/admin/read_models/upstream_accounts_read_model.ex`
- `lib/codex_pooler_web/live/admin/forms/upstream_filter_form.ex`

The dashboard has a compact, full-width metric strip with Total, Active, Reauth required, Needs attention, Quota >=70%, Quota 30-69%, Quota <30%, Exhausted, and Quota unknown.

Metrics are computed from the Pool-scoped account projection before query/status/quota filters. Filters narrow the card list but intentionally do not alter fleet metrics. Keep the expensive account projection single-pass; do not query/project accounts again just for statistics.

The URL-backed filters are `query`, `pool_id`, `status`, `quota`, and `sort`. Quota values are `plenty`, `moderate`, `low`, `exhausted`, and `unknown`. Sort values are recent, name, status, and most quota. New filters must include normalization, URL serialization, UI wiring, read-model behavior, and malformed-value tests.

Filter controls intentionally occupy one full-width row at 32px height. Search receives twice the width of each select. `AdminComponents.filter_form/1` has a fork-specific `fields_class` assign for this layout.

Quota bands use the maximum **used** percentage across non-spending-cap quota rows, then expose its complementary remaining-quota label:

- used <30% -> `plenty` / quota >=70%
- used 30-69% -> `moderate`
- used 70-99% -> `low` / quota <30%
- used >=100% -> `exhausted`
- no percentage -> `unknown`

Do not invert this without updating calculations, labels, filters, sorting, metrics, and tests together.

Account cards no longer render “last used” text. Last-used data is still needed for the default recent sort. Quota progress bars represent used percentage. Accounts without a spending cap receive a neutral gray `Spending Cap` row labeled `Not set`.

Per-model/family additional quota windows remain in the account projection for fleet metrics and filtering, but are intentionally hidden from account-card UI. Cards render only the fixed atom-keyed account meters (`5h`, `30d`, `Weekly`, `Monthly Usage`, and `Spending Cap`). Preserve this card-level filter when reconciling upstream quota-projection changes; do not reintroduce additional-limit progress bars.

## OAuth credential freshness and auth.json viewing

This fork keeps Codex OAuth credentials current beyond upstream behavior.

Initial browser/device OAuth linking stores encrypted `access_token`, `refresh_token`, and `id_token` secrets. Successful refreshes always replace the access token and also replace refresh/id tokens when the provider returns rotated values. `id_token` requires the fork migration `priv/repo/migrations/20260726000001_add_id_token_secret_kind_to_encrypted_secrets.exs`.

`metadata["access_token_expires_at"]` is derived from the provider's positive `expires_in` first, then from the access-token JWT `exp` claim. A successful refresh with neither source clears any stale expiry instead of preserving a false deadline. Admin labels read this stored metadata; they do not decode the JWT on every render. Reauth-required accounts intentionally show `Reauth required` instead of a future access-token countdown.

`TokenRefreshRecovery` adds active identities to the normal scheduled refresh fanout when all of these hold:

- `access_token_expires_at` is within 12 hours or already past
- an active refresh-token secret exists
- the identity has an active assignment in an active Pool
- no incomplete `TokenRefreshWorker` job already exists

Keep the 12-hour selection bounded in the database; do not load every active identity and filter it in Elixir. This refreshes access credentials proactively but cannot prevent provider-side refresh-token/session revocation.

Operators can open a read-only Current auth.json dialog from the upstream list or cockpit. `Upstreams.export_auth_json_for_scope/2` authorizes through `AccountLifecycle`, decrypts the currently active token secrets, and audits `upstream_account.auth_json_view` without recording secret values. It renders the credentials currently stored; missing access, refresh, or id tokens appear as JSON `null` rather than blocking the dialog. Therefore partial output is inspectable but is not guaranteed to be importable as a complete Codex auth.json.

## Compass upstream support

This fork also supports Compass project-key upstreams, which upstream does not. The admin upstream page can import a Compass project into encrypted storage. Identity metadata uses provider `compass`, its project ID, and a Compass base URL; the project key is the active `access_token`. Project-detail quota reads additionally require a separate gateway token stored as secret kind `other`; the current import dialog does not collect it, so those reads remain unavailable until that secret is provisioned separately.

Compass requests bypass ChatGPT-specific translation and headers for `/v1/chat/completions` and `/v1/responses`, routing directly to `/chat/completions` and `/responses`. Model discovery uses `/models`. Quota reconciliation calls `/open_project/detail/:project_id`, converts the project balance into an authoritative account quota window, and treats recurring budgets as calendar-month windows. Keep these transport, discovery, import, and quota paths aligned when changing provider detection or secret conventions.

## Immediate account connection test

Entry point: `Upstreams.test_account_for_scope/2`.

Implementation is in `lib/codex_pooler/upstreams/account_test_enqueue.ex`. Despite the legacy module name, this is synchronous reconciliation, not an Oban enqueue.

The LiveView runs it with `start_async/3`. During the request, only that account ID is stored in `testing_account_ids`; its menu action changes to `Testing…`, uses a refresh icon, and is disabled. Loading state is removed on success, returned error, or task exit.

The backend authorizes through `AccountLifecycle`, selects an active Pool assignment, and calls reconciliation with:

```elixir
record_summary?: false,
allow_persisted_fallback?: false
```

Never enable persisted fallback for this action: “Account works” must require a fresh provider response. It probes authenticated OpenAI usage endpoints such as `/backend-api/wham/usage`, `/backend-api/codex/usage`, and `/api/codex/usage`; it does not send a model prompt. The normal receive timeout is 30 seconds.

A test can update quota, assignment health, reconciliation status, and provider metadata. It is not a side-effect-free ping.

When changing nested account action components, explicitly pass `testing?`. Direct `AccountCard.account_card/1` rendering also relies on its `assign_new(..., :testing?, false)` fallback; omitting this previously caused a `KeyError`.

## Spending caps

Schema fields on `upstream_identities`:

- `spend_cap_credits`: integer; `0` means uncapped
- `spent_credits`: accumulated decimal spend for the current cap period
- `cap_started_at`: start of the current cap period

Migrations:

- `priv/repo/migrations/20260721000001_add_spend_cap_to_upstream_identities.exs`
- `priv/repo/migrations/20260721170000_add_missing_spent_credits_to_upstream_identities.exs`

The second migration is intentionally defensive for databases with divergent migration history; do not casually remove it.

The scoped operation is `Upstreams.update_spend_cap_for_scope/3`. Setting a cap resets `spent_credits` and starts a new period. Spending caps are not constrained by provider-reported remaining `spend_control` quota; `0` means uncapped.

Provider parsing treats `payload["spend_control"]["individual_limit"]` as a dedicated `spend_control` quota window. Keep `CodexParsers` and `UsageProbe` aligned if this payload changes. This fork replaced upstream's generic `additional_rate_limits` parsing with explicit spend-control evidence, so future upstream parser changes need manual reconciliation.

Settlement accounting increments spend only for attempts started on or after `cap_started_at`. Replacement settlements apply only their delta, and accumulated spend is clamped at zero. Current conversion is:

```text
credits = settled_cost_micros / 40_000
```

The operator UI accepts dollars and currently converts at 25 credits per dollar. If credit pricing changes, update both accounting and UI conversions plus tests.

Routing policy:

- below 85%: normal
- 85% to below 100%: reserved; excluded while a less-used candidate exists
- at or above 100%: excluded from new sessions
- pinned continuation may proceed below 125%
- pinned continuation at or above 125% returns 503 `pinned_continuation_spend_cap_reached`
- accounts are not automatically paused when they exceed their spending cap; routing eligibility enforces the cap

Spend-cap eligibility runs before quota eligibility. This fork also defaults routing `quota_mode` to `:optional`; missing provider quota evidence does not block routing unless a caller explicitly requests `:required`.

Individual and bulk cap UI lives primarily in `upstreams_live/spend_cap_workflow.ex`. Bulk targets are all accounts, cap-reached accounts, or uncapped accounts. Bulk selection uses all identities visible to the scope, not only currently filtered cards. Bulk updates are sequential and not atomic; do not describe them as transactional.

## Account deletion is physical

Despite the retained compatibility name `soft_delete_account_for_scope/3`, operator deletion now hard-deletes the `upstream_identities` row.

Before `Repo.delete!/1`, `AccountLifecycle` detaches nullable historical references that otherwise block cascades:

- `codex_turns.final_attempt_id`
- `ledger_entries.attempt_id`
- `ledger_entries.pool_upstream_assignment_id`
- `ledger_entries.upstream_identity_id`

Database cascades then remove account-owned assignments, encrypted secrets, quota windows, and other dependent rows. Request/accounting history remains where allowed, but no longer points to the deleted account.

The function returns a synthetic in-memory lifecycle result whose identity status is `deleted` so audit/event code retains its expected shape. That identity is not persisted. New code and tests must use `Repo.get(...) == nil` after deletion. Reactivation returns `upstream_identity_not_found`.

Authorization and assignment capture must occur before deletion because Pool membership disappears with cascading assignments. Deletion remains audited as `upstream_account.delete` using the captured pre-delete identity and assignments.

The `deleted` status vocabulary still exists for assignment and legacy/read-model cases. Do not infer that account deletion is soft from the vocabulary or function name.

Any future `NO ACTION` foreign key referencing identities, Pool assignments, or attempts can break hard deletion. Update the detach logic or FK policy when adding such constraints.

## Local development

Development PostgreSQL defaults to port 5433. Port precedence is:

1. `CODEX_POOLER_DEV_POSTGRES_PORT`
2. `POSTGRES_PORT`
3. `5433`

The commonly running local database uses 5432, so standalone commands may need:

```bash
CODEX_POOLER_DEV_POSTGRES_PORT=5432 mix ...
CODEX_POOLER_TEST_POSTGRES_PORT=5432 mix test ...
```

`Makefile` contains customized database startup/recovery behavior. `make dev-db` starts only the DB, waits for host TCP access, resets the development role password, and may force-recreate a healthy-but-unreachable container without deleting its volume. Compose defaults to `podman-compose` and can be overridden with `COMPOSE_BIN`.

- `start.command`: manages the compose database, creates/migrates it, then starts Phoenix.
- `start.dev.command`: uses an existing database, probing 5433 then 5432 when no port is provided.

Both scripts kill the process occupying the configured app port before startup; use carefully on shared machines.

## Validation

Use formatting and focused tests while iterating, then run at least:

```bash
mix format
mix compile
CODEX_POOLER_TEST_POSTGRES_PORT=5432 mix test \
  test/codex_pooler/upstreams_test.exs \
  test/codex_pooler_web/live/admin/pages/upstreams_live_test.exs \
  test/codex_pooler_web/live/admin/pages/upstream_cockpit_live_test.exs
git diff --check
```

Recent focused lifecycle, hard-delete, account-card, connection-test, filter, and spending-meter tests passed. The complete repository suite has not been run against every current working-tree customization, so do not claim full regression coverage without running it.
