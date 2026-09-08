# Hosting the beta

The app is a single Docker service with a persistent `/data` volume. It is designed so the poker server, website, database and chat-image storage can run together for a private beta.

## Recommended first deployment shape

- 1 always-on Node/Docker instance.
- Persistent disk mounted at `/data`.
- HTTPS enabled by the hosting provider.
- A custom domain can be attached after the beta URL works.

Do **not** deploy multiple app replicas while using the built-in SQLite database. Multiple replicas would each have separate in-memory active-room state. If the site later needs horizontal scaling, migrate persistence to PostgreSQL/Redis first.

## Easiest update workflow

1. Put this project in a private GitHub repository.
2. Keep experimental changes on a `dev` branch.
3. Push to `dev`; GitHub Actions runs syntax checks and the poker test suite.
4. Deploy `dev` to a staging instance if desired.
5. Merge tested changes into `main`.
6. The included deployment workflow can deploy `main` automatically once a hosting token is configured.

The repository contains a Fly.io example because it supports Docker + persistent volumes cleanly. The same Dockerfile can also be used on Railway, Render, a VPS, or another Docker host that offers a persistent disk.

## Fly.io outline

1. Install/configure Fly CLI and create an app.
2. Copy `fly.toml.example` to `fly.toml` and replace the app name.
3. Create a persistent volume named `poker_data` in the chosen region.
4. Deploy once manually.
5. Add `FLY_API_TOKEN` as a GitHub repository secret.
6. Future merges to `main` run tests and deploy automatically through `.github/workflows/deploy-fly.yml`.

## Backups

Run `npm run backup` periodically and copy backup files somewhere separate from the production volume. A production host snapshot is helpful too, but it should not be the only backup.

## Before inviting the full group

- Register the site admin account first.
- Create a test group.
- Play and end a small session.
- Verify the final ledger appears in the group.
- Verify a manually flagged issue appears in the admin bug inbox.
- Restart the service during an active test room and confirm the room restores.
- Confirm pasted chat images survive a service restart because `/data` is persistent.
