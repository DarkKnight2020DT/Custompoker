# Custom Poker — Hosted Beta 1.1

Repository-ready build of the custom poker site.

## Included

- Accounts with real-name identity and changeable table nickname
- Poker groups, invite codes, memberships, group history
- Persistent ledgers, leaderboards, and external-payment settlement tracking
- Existing configurable poker engine (Hold'em/Omaha, 2–8 hole cards, 1–4 boards, bomb pots, custom Hi/Low declarations, runouts, timers, anti-nit, 7-2, buy-ins, side pots, testing bots, etc.)
- Text/emoji/pasted-image room chat
- Help & Rules panel highlighting active rules
- Persistent active-room checkpoints
- Admin bug inbox and automatically stored session debug traces
- Downloadable/copyable debug bundles
- Test sessions clearly excluded from real leaderboards and settlements
- Final ledger navigation: Home, Back to Group, Create Another Game

## Local run

Requires Node.js 24+.

```bash
npm install
npm test
npm start
```

Open `http://localhost:3000`.

## GitHub deployment

See [GITHUB_SETUP.md](GITHUB_SETUP.md). This is a server application, so **GitHub Pages alone cannot host it**. Use a service that deploys Node/Docker apps from GitHub and attach persistent storage at `/data`.

## Environment

Copy `.env.example` values into your hosting provider's environment configuration. The most important production setting is:

```text
DATA_DIR=/data
```

where `/data` is a persistent mounted disk/volume.

## Tests

```bash
npm test
npm run check
```

The GitHub Actions workflow runs tests automatically on pushes and pull requests.
