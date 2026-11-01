# Teddyxhost

Teddyxhost is a Heroku bot-deployment dashboard with email/password authentication, templates, deployments, wallet/payment records, and admin tools.

## Database

The API persistence layer is configured for MongoDB Atlas. Set these environment variables on Heroku:

- `MONGODB_URI` — MongoDB Atlas connection string. Keep this secret.
- `MONGODB_DB_NAME` — optional database name; if omitted, the driver uses the database in the URI.
- `SESSION_SECRET` — long random secret used for authentication/session signing.
- `PORT` — supplied automatically by Heroku.

Do not set `DATABASE_URL` for the Teddyxhost API database. The `DATABASE_URL` references in deployment management are separate: they inspect/provision a database add-on for a *deployed customer bot* where that bot's configuration needs it.

## Authentication

The web UI uses email and password. Google/GitHub OAuth routes and buttons are not registered in the active app.

## Install and build

This repository is a pnpm workspace. After changing workspace dependencies, run `pnpm install` and commit the updated `pnpm-lock.yaml` before deploying. Then run `pnpm build`.

## Important

The MongoDB adapter preserves the existing query-style API while moving runtime persistence to MongoDB collections. Validate this migration against a staging Atlas database before using real payment balances or production deployments. MongoDB transactions require a replica-set deployment, which Atlas provides.

## Configuration file
The root `config.js` lists the supported runtime configuration values and reads them from environment variables. Add secrets in Heroku **Settings → Config Vars**; do not put real MongoDB or Paystack credentials into the repository. `.env.example` documents all supported variables. Heroku supplies `PORT` automatically.


### Heroku URLs
If the frontend and API are served from the same Heroku app, you do not need to set `FRONTEND_URL` or `BACKEND_URL`. Payment callback URLs are derived from the incoming request. Set `FRONTEND_URL` only if you host the frontend on a separate domain.
