# Hidden Admirer — v0.2

A deployable full-stack web starter for **authorized account insights**. It includes a polished Arabic RTL dashboard, account registration/login, PostgreSQL persistence, scan history, change detection, and a server-side Meta Graph API integration point.

## What is implemented

- Responsive dark dashboard and Arabic interface.
- User registration and login. Passwords are hashed with bcrypt.
- Server-side sessions stored in PostgreSQL.
- Each user's tracked profiles and scan history are isolated by user ID.
- Instagram Business Discovery request is made from the server, never from browser JavaScript.
- Saved snapshots are compared to detect changes in display name, biography, website, profile picture URL, follower count, media count, and newly visible media IDs.
- Lightweight topic hints from visible post captions (gaming, travel, photography, music, sports, food, books, films).
- Rate limits on login/register and scanning.
- Docker Compose setup for the web app and PostgreSQL.

## Important scope

The scan flow is intended only for an account the operator owns or has explicit permission to analyze. It does not scrape Instagram pages, bypass private-account settings, access private messages, story viewers, hidden follow relationships, or private engagement data.

The official Instagram API is limited. Business Discovery generally exposes eligible public Business/Creator accounts and only fields permitted by Meta and the granted permissions. It does not expose every consumer/personal account or every activity a person performs. No historical changes can be reconstructed before the first saved scan.

## Run locally

1. Install Docker Desktop or Docker Engine with the Compose plugin.
2. Copy `.env.example` to `.env`.
3. Set a long random `SESSION_SECRET` (at least 32 characters).
4. Set `DB_PASSWORD` in the shell or `.env` to a strong database password. The compose file defaults to an insecure example password for local development only.
5. Start:

   ```bash
   docker compose up --build
   ```

6. Open `http://localhost:3000`.

To run without Docker, provide PostgreSQL yourself, set `DATABASE_URL`, copy the environment variables, run `npm install`, then `npm start`.

## Configure Meta

Before real Instagram scans, configure an eligible Meta developer app and the required Instagram Graph API access. The connected Instagram professional account and permissions must be eligible for Business Discovery.

Set these server-side variables in `.env`:

- `META_GRAPH_VERSION=v27.0`
- `META_IG_USER_ID=<your connected Instagram professional account ID>`
- `META_ACCESS_TOKEN=<valid server-side access token>`

Never commit `.env`, expose tokens in frontend code, or send tokens to end users. Meta may require app review, business verification, and specific permissions before a production app can query the API. Verify current requirements in Meta's developer dashboard and documentation.

If these settings are absent, the site still runs and user accounts work, but the scan endpoint returns a clear setup message.

## Production deployment

This repository is deployment-ready as a containerized app, but it is **not already hosted on a public server**. To publish it, deploy the Compose services to a VPS or a container host, configure a domain and HTTPS reverse proxy, add production secrets and the Meta credentials, and test account creation, login, and the Meta integration.

Recommended production checks:
- Use HTTPS and set `NODE_ENV=production`.
- Use strong unique `SESSION_SECRET` and `DB_PASSWORD` values.
- Use managed PostgreSQL backups and restrict database network access.
- Configure `PGSSLMODE=require` if the database provider requires TLS.
- Complete Meta app review and verify the approved permissions and API fields.
- Publish a privacy notice, retention policy, and account deletion workflow before inviting other users.
- Set appropriate legal age/consent requirements for the service's intended audience.

## Known limitations in v0.2

- No public deployment, domain, or Meta app credentials are included.
- No Instagram OAuth onboarding flow yet; a server operator must configure the authorized Meta connection.
- Only the latest media returned by the official API is compared.
- Topic hints are basic caption keyword matches, not AI image recognition or personality analysis.
- No password reset, email verification, administrator console, billing, or user-facing data export/delete screen yet.
