#!/bin/bash
set -e

cd "$(dirname "$0")"
export PATH="$HOME/.local/bin:$PATH"
eval "$(mise activate bash)"

APP_PORT="${PORT:-4000}"
DB_PORT="${POSTGRES_PORT:-}"
PIDS="$(lsof -ti tcp:"$APP_PORT" 2>/dev/null || true)"

if [ -n "$PIDS" ]; then
  echo "Killing process on port $APP_PORT: $PIDS"
  kill $PIDS 2>/dev/null || true
  sleep 1
fi

if [ -z "$DB_PORT" ]; then
  if (: > /dev/tcp/127.0.0.1/5433) >/dev/null 2>&1; then
    DB_PORT=5433
  elif (: > /dev/tcp/127.0.0.1/5432) >/dev/null 2>&1; then
    DB_PORT=5432
  else
    echo "No local Postgres found on 5433 or 5432"
    echo "Use start.command for podman-managed DB, or start your local Postgres first"
    exit 1
  fi
fi

echo "Using app port: $APP_PORT"
echo "Using postgres port: $DB_PORT"

echo "Creating database if needed..."
POSTGRES_PORT="$DB_PORT" PORT="$APP_PORT" mix ecto.create

echo "Running migrations..."
POSTGRES_PORT="$DB_PORT" PORT="$APP_PORT" mix ecto.migrate

echo "Starting Phoenix dev server..."
POSTGRES_PORT="$DB_PORT" PORT="$APP_PORT" mix phx.server
