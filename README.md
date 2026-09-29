# Cloud-Native Deployment & Reliability Control Plane

This repository currently contains the Phase 1 Step 1 development foundation. The backend is a strict TypeScript/Express application with a dependency-independent health check, request IDs, structured request logs, basic error handling, and PostgreSQL/Prisma connectivity support. Deployment orchestration and infrastructure are not implemented.

## Prerequisites

- Node.js 22 or newer and npm
- Docker Desktop with Docker Compose for the local database/container workflow

## Windows path note

This checkout's folder path contains `&`. Windows npm script launching can split paths containing that character. In PowerShell, map the repository to a drive before running npm commands:

```powershell
subst R: "$PWD"
Set-Location R:\controller
npm install
npm run dev
```

Run the remaining controller npm commands from `R:\controller`; run Docker Compose from `R:\`.

## Backend commands

Run from `controller/`:

```sh
npm install
npm run dev
npm test
npm run typecheck
npm run build
npm start
```

Development server: `http://localhost:3000/health`.

The server reads `NODE_ENV`, `PORT`, `DATABASE_URL`, and optional `REDIS_URL` in one configuration module. Redis is not part of the MVP runtime and is not started by Compose.

## Local PostgreSQL

From the repository root, set a local-only password in your shell; do not commit it or place it in source files.

PowerShell:

```powershell
$env:POSTGRES_PASSWORD = 'choose-a-local-password'
docker compose up -d postgres
```

Bash:

```sh
export POSTGRES_PASSWORD='choose-a-local-password'
docker compose up -d postgres
```

PostgreSQL is published on port 5432 by default. Set `POSTGRES_PORT` to change it. The local database uses a named volume. Start the controller and database together with `docker compose up --build` (after setting `POSTGRES_PASSWORD`). The controller container waits for PostgreSQL's readiness check, though its `/health` endpoint itself remains process-only.

To check Prisma-to-PostgreSQL connectivity from the host, set `DATABASE_URL` to the local connection string and run `npm run db:check` from `controller/`. Example for PowerShell:

```powershell
$env:DATABASE_URL = "postgresql://platform:$env:POSTGRES_PASSWORD@localhost:5432/deployment_control_plane?schema=public"
Set-Location controller
npm run db:check
```

The Prisma schema intentionally contains no deployment/domain models at this phase.

## Request IDs and errors

A valid UUID supplied in `x-request-id` is reused; any invalid or missing value is replaced with a generated UUID. The response returns `x-request-id`; structured request logs include timestamp, level, message, and request ID. Expected `AppError` instances return a structured error. Unexpected errors are logged and return a generic response without stack details in production.
