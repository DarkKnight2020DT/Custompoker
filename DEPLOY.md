# Deployment

This app has no external runtime npm dependencies. Any host that can run Node.js 20+ can run it.

## Simple Node host

Set the start command to:

```bash
npm start
```

The server listens on `process.env.PORT` and binds to `0.0.0.0`.

## Docker

```bash
docker build -t custom-poker .
docker run --rm -p 3000:3000 custom-poker
```

Then visit `http://localhost:3000`.

## Before exposing a permanent public deployment

The current build is intended for private friend groups and testing. Rooms are stored in memory and disappear when the process restarts. Before treating it as a public service, add durable persistence, HTTPS at the reverse proxy/host, request rate limiting, an explicit room expiry policy, monitoring, backups if history is persisted, and stronger account/host authentication if money or public users are ever involved.

For private play-money home games, deploy behind HTTPS and keep invite links private.
