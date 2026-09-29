# Controller Foundation

Minimal TypeScript and Express foundation for the Cloud-Native Deployment & Reliability Control Plane. This step provides only the HTTP health endpoint, request context, structured logging, basic error handling, PostgreSQL connectivity support, and local development tooling. Deployment behavior is not implemented.

## Requirements

Node.js 22 or later and npm. Docker Desktop with Compose is needed for local PostgreSQL and container workflows.

## Commands

From this directory:

```sh
npm install
npm run dev
npm test
npm run typecheck
npm run build
npm start
npm run db:check
```

`GET /health` returns HTTP 200 and `{ "status": "ok" }` without contacting dependencies.

A valid UUID in `x-request-id` is reused; invalid or missing values receive a generated UUID. The ID is returned in the same response header and included in request logs.

Set `DATABASE_URL` to run `npm run db:check`. `REDIS_URL` is accepted as optional configuration for future phases but Redis is not used or started by this MVP foundation.

On Windows, if the checkout path contains `&`, map the repository root to a drive letter with `subst R: "$PWD"`, then run these commands from `R:\controller` to avoid npm command-shell path parsing issues.