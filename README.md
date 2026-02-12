# spotify recents web

simple spotify recently-played web app with oauth.

## local run

1. copy `.env.example` to `.env`
2. fill env values
3. install deps:
   `npm install`
4. start:
   `npm start`
5. open:
   `http://127.0.0.1:3000`

## spotify redirect uri

for local dev, use this exact redirect uri in spotify dashboard and `.env`:

`http://127.0.0.1:3000/api/callback`

for vercel production, use:

`https://<your-project>.vercel.app/api/callback`

## deploy to vercel

1. push repo to github
2. import repo in vercel
3. set env vars in vercel project settings:
   - `spotify_client_id`
   - `spotify_client_secret`
   - `spotify_redirect_uri` (your vercel callback url)
   - `session_secret`
4. redeploy

## notes

- sessions are stored in encrypted http-only cookies.
- each user signs in with their own spotify account.
