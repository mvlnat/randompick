# RandomPick

Private personal web app for nested lists, lightweight decision-making, and random selection.

## Stack

- Single Node service
- Browser-side ES modules
- SQLite via Node's built-in `node:sqlite`
- No external runtime dependencies

## Run locally

```bash
cd /Users/ziyangli/Coding/randompick
npm start
```

The app runs on `http://localhost:8080` by default.

Useful environment variables:

- `HOST`: bind host, defaults to `127.0.0.1`
- `PORT`: HTTP port, defaults to `8080`
- `DATABASE_PATH`: SQLite path, defaults to `./data/randompick.db`

## Tests

```bash
cd /Users/ziyangli/Coding/randompick
npm test
```

## Production

- single container runtime
- SQLite database stored on a mounted volume
- routed through the shared VM edge at `random.ziyang.li`

Release with:

```bash
cd /Users/ziyangli/Coding/randompick
scripts/release-prod.sh --message "your release message"
```

See [docker-compose.prod.yml](/Users/ziyangli/Coding/randompick/docker-compose.prod.yml), [scripts/release-prod.sh](/Users/ziyangli/Coding/randompick/scripts/release-prod.sh), and [deploy/randompick-shared-edge.nginx.conf.example](/Users/ziyangli/Coding/randompick/deploy/randompick-shared-edge.nginx.conf.example).
