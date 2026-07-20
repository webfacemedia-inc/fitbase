# AGENTS.md — building this app on webface.cloud

You are working on an app hosted on webface.cloud. Read this whole file before writing code. These instructions are exact; follow them literally.

## The platform in one paragraph

This repo is the FRONTEND of the app. The BACKEND already exists and is running: a PocketBase instance at the same origin. `/` serves the files in this repo, `/api/...` is the backend (database, auth, file storage, realtime), `/_/` is the human admin panel. Deploying is `git push` — a webhook rebuilds and ships this repo automatically. There is no server code in this repo and you must not add any.

## Hard rules

1. **Never build a server.** No Express, no Flask, no serverless functions. The backend exists. If a feature seems to need server code, it needs a collection + API rules instead (a human sets those up in `/_/`, or you ask for them).
2. **Same-origin SDK only.** Always `new PocketBase('/')`. Never hardcode another host. Never disable CORS — there is no CORS because there is one origin.
3. **Escape user content** before inserting into the DOM. Every string from the database is untrusted.
4. **Keep it buildless if it is buildless.** If this repo has no package.json, do not add one unless the human asks. Static repos deploy as-is; that simplicity is a feature.
5. **If this repo has package.json**, the platform runs `npm ci && npm run build` and serves `dist/` (or `build/`). Your build must work with exactly that command.
6. **Client-side routing works** — unknown paths fall back to index.html.
7. **Secrets never go in this repo.** There are no frontend secrets; the API enforces access rules server-side.

## SDK patterns (PocketBase JS)

```js
const pb = new PocketBase('/');

// read
const page = await pb.collection('items').getList(1, 20, { sort: '-created', filter: "done = false" });

// create (auth required if the collection's rule says so)
await pb.collection('items').create({ title: 'x', owner: pb.authStore.record.id });

// auth: email/password
await pb.collection('users').authWithPassword(email, password);
// auth: Google (works once the human enables it in /_/)
await pb.collection('users').authWithOAuth2({ provider: 'google' });
// session persists in localStorage automatically; check pb.authStore.isValid

// realtime — changes stream to every open browser (SSE, no setup)
pb.collection('items').subscribe('*', (e) => { /* e.action: create|update|delete, e.record */ });

// files: a `file` field on a record; URL via pb.files.getURL(record, record.photo)
```

## What you cannot do from here (ask the human)

- Create or alter collections, fields, or API rules (done in `/_/` by the owner).
- Enable OAuth providers (owner pastes the client ID in `/_/`).
- Attach custom domains, see server logs, restart the app (owner's dashboard).

## Verifying your work

After pushing, the app redeploys in under a minute. Check the live URL. If the page is stale, the deploy may have failed — tell the human to check the app card on their dashboard for the deploy error.
