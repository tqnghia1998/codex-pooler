defmodule CodexPoolerWeb.Admin.UpstreamPageComponents.CompassDialog do
  @moduledoc false

  use CodexPoolerWeb, :html

  alias CodexPoolerWeb.Admin.Components, as: AdminComponents

  attr :compass_form, :any, required: true
  attr :importing_compass, :boolean, required: true
  attr :pool_options, :list, required: true

  def compass_import_dialog(assigns) do
    ~H"""
    <dialog :if={@importing_compass} id="compass-import-dialog" class="modal" open>
      <div class="modal-box max-w-2xl border border-base-300 bg-base-100 p-0 shadow-2xl">
        <div class="border-b border-base-300 px-6 py-5">
          <p class="text-sm font-semibold uppercase tracking-wide text-primary">
            Upstream credentials
          </p>
          <h2 class="mt-1 text-2xl font-bold text-base-content">Import Compass project</h2>
          <p class="mt-2 w-full text-sm leading-6 text-base-content/70">
            Store a Compass project key in encrypted upstream storage.
          </p>
        </div>

        <.form
          id="compass-import-form"
          for={@compass_form}
          phx-change="validate_compass_import"
          phx-submit="import_compass"
          autocomplete="off"
          class="grid gap-5 p-6"
        >
          <.input
            field={@compass_form[:pool_id]}
            type="select"
            label="Target Pool"
            options={@pool_options}
          />

          <div
            :if={compass_form_error_messages(@compass_form) != []}
            id="compass-import-errors"
            class="rounded-box border border-error/30 bg-error/10 p-3 text-sm text-error"
          >
            <p :for={message <- compass_form_error_messages(@compass_form)}>{message}</p>
          </div>

          <.input
            field={@compass_form[:project_id]}
            type="text"
            label="Project ID"
            placeholder="project-id"
          />

          <.input
            field={@compass_form[:project_key]}
            type="password"
            label="Project key"
            placeholder="sk-..."
            value=""
          />
        </.form>

        <AdminComponents.dialog_footer id="compass-import-dialog-footer">
          <:actions>
            <AdminComponents.action_button
              id="compass-import-cancel"
              label="Cancel"
              variant={:ghost}
              phx-click="cancel_import_compass"
            />
            <AdminComponents.action_button
              id="compass-import-submit"
              icon="hero-key"
              label="Import Compass"
              type="submit"
              form="compass-import-form"
              variant={:primary}
            />
          </:actions>
        </AdminComponents.dialog_footer>
      </div>
      <form method="dialog" class="modal-backdrop">
        <button type="button" phx-click="cancel_import_compass">close</button>
      </form>
    </dialog>
    """
  end

  defp compass_form_error_messages(form) do
    form.errors
    |> Enum.map(fn
      {_field, {message, _opts}} -> message
      {_field, message} when is_binary(message) -> message
    end)
    |> Enum.uniq()
  end
end
