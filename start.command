#!/bin/bash
set -e

cd "$(dirname "$0")"
export PATH="$HOME/.local/bin:$PATH"
eval "$(mise activate bash)"

APP_PORT="${PORT:-4000}"
DB_PORT="${POSTGRES_PORT:-5433}"
DB_WAIT_TIMEOUT="${POSTGRES_WAIT_TIMEOUT:-60}"
DB_WAIT_ATTEMPTS="${POSTGRES_WAIT_ATTEMPTS:-$DB_WAIT_TIMEOUT}"
COMPOSE_BIN="${COMPOSE_BIN:-podman-compose}"
PIDS="$(lsof -ti tcp:"$APP_PORT" 2>/dev/null || true)"

if [ -n "$PIDS" ]; then
  echo "Killing process on port $APP_PORT: $PIDS"
  kill $PIDS 2>/dev/null || true
  sleep 1
fi

command -v "$COMPOSE_BIN" >/dev/null 2>&1 || {
  echo "$COMPOSE_BIN not found in PATH"
  exit 1
}

echo "Using app port: $APP_PORT"
echo "Using postgres port: $DB_PORT"
echo "Starting docker-compose.dev.yml db service with $COMPOSE_BIN..."
POSTGRES_PORT="$DB_PORT" "$COMPOSE_BIN" -f docker-compose.dev.yml up -d db

echo "Waiting for Postgres..."
for _ in $(seq 1 "$DB_WAIT_ATTEMPTS"); do
  if (: > /dev/tcp/127.0.0.1/"$DB_PORT") >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

if ! (: > /dev/tcp/127.0.0.1/"$DB_PORT") >/dev/null 2>&1; then
  echo "Postgres is not reachable on localhost:$DB_PORT after ${DB_WAIT_ATTEMPTS}s"
  POSTGRES_PORT="$DB_PORT" "$COMPOSE_BIN" -f docker-compose.dev.yml ps
  exit 1
fi

echo "Creating database if needed..."
POSTGRES_PORT="$DB_PORT" PORT="$APP_PORT" mix ecto.create

echo "Running migrations..."
POSTGRES_PORT="$DB_PORT" PORT="$APP_PORT" mix ecto.migrate

echo "Starting Phoenix..."
POSTGRES_PORT="$DB_PORT" PORT="$APP_PORT" mix phx.server
