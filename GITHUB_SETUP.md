# GitHub repository setup

This folder is ready to become the root of a GitHub repository.

## Upload with the GitHub website

1. Create a new empty repository on GitHub.
2. Upload the contents of this folder (not the containing folder itself).
3. Commit to `main`.
4. Connect that GitHub repository to a host that supports a long-running Node.js or Docker web service.
5. Mount persistent storage at `/data` and set `DATA_DIR=/data`.
6. Health check: `/api/health`.
7. Start command when Docker is not used: `npm start`.

## Important: GitHub Pages is not enough

This application is not a static site. It runs a Node.js backend, SQLite database, Server-Sent Events for live rooms, authentication, image uploads, and persistent game/session data. GitHub Pages can host only the static frontend and therefore cannot run the poker website by itself.

A provider that deploys **from a GitHub repository** and supports Node/Docker works. This repository includes `Dockerfile`, `render.yaml`, `railway.json`, and `Procfile` examples.

## Persistence

Do not deploy with an ephemeral filesystem unless you are only doing temporary testing. Accounts, groups, ledgers, settlements, debug traces, active-room checkpoints, and pasted chat images are stored under `DATA_DIR`.

## Updates

Push changes to GitHub. The included GitHub Actions workflow runs the test suite. Configure the hosting provider to auto-deploy `main` only after checks pass, or use a staging branch/service before production.
