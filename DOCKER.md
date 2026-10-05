# Backend deployment

Run these commands from `hr-b` (the Docker build context):

```sh
docker build -t hr-api:latest .
docker run -d --name hr-api --restart unless-stopped --init \
  --env-file .env.production -e NODE_ENV=production -e PORT=4000 \
  -p 4000:4000 hr-api:latest
```

Create `.env.production` on the server using `.env.example` as a template. Set
`DATABASE_URL` to the reachable MySQL database, `FRONTEND_ORIGIN` to the frontend
HTTPS origin, and `BANK_ACCOUNT_ENCRYPTION_KEY` to a persistent 64-character hex
key. Preserve the existing encryption key when deploying an existing database.
Inside a container, `localhost` refers to the container itself, not the server
or another database container. Set `TRUST_PROXY` to the actual proxy hop count
when running behind a reverse proxy.

The image does not contain `.env` files. Runtime variables are supplied with
`--env-file`; `NODE_ENV=production` is explicitly enforced in the command above.
For a reverse proxy on the same server, use `-p 127.0.0.1:4000:4000` instead.

Database migrations are a separate deployment step. Back up the database and
review the pending migrations before running them. For an existing numeric-ID
migration deployment, follow the project's database migration procedure first.
For a database ready for normal Prisma deployment:

```sh
docker build --target build -t hr-api:migrate .
docker run --rm --init --env-file .env.production hr-api:migrate \
  npx prisma migrate deploy
```

Run migrations before starting the new API container. They are not automatically
executed at application startup. Check the deployment with:

```sh
docker logs --tail 100 hr-api
curl http://localhost:4000/api/v1/health
```
