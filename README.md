# 🎧 spotify recents

a monochrome spotify web app where anyone can connect their account and view:

- recently played tracks
- currently listening track
- quick listening stats

## ✨ features

- spotify oauth login
- switch account flow (`/api/login?switch=1`)
- disconnect flow (`/api/logout`)
- currently listening panel
- recent tracks list with album art + spotify links
- encrypted http-only cookie sessions
- lightweight api rate limiting to reduce spam requests

## 🧱 stack

- node.js + express
- vanilla html/css/js frontend
- vercel deployment

## 🚀 local setup

1. install dependencies:
`npm install`
2. copy env file:
`copy .env.example .env`
3. fill `.env` values
4. run app:
`npm start`
5. open:
`http://127.0.0.1:3000`

## 🔐 environment variables

- `spotify_client_id` = spotify app client id
- `spotify_client_secret` = spotify app secret
- `spotify_redirect_uri` = callback url for current environment
- `session_secret` = long random secret used to encrypt/sign cookies
- `port` = local server port (default `3000`)

generate a session secret:

`node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"`

## 🔁 spotify redirect uri setup

set redirect uri exactly in both spotify dashboard + env:

- local: `http://127.0.0.1:3000/api/callback`
- production: `https://<your-project>.vercel.app/api/callback`

required spotify scopes used by this app:

- `user-read-recently-played`
- `user-read-currently-playing`

## 🌐 deploy to vercel

1. push this repo to github
2. import repo in vercel
3. set environment variables in vercel project settings:
- `spotify_client_id`
- `spotify_client_secret`
- `spotify_redirect_uri`
- `session_secret`
4. redeploy
5. update spotify dashboard redirect uri to your vercel callback

## 📦 api routes

- `GET /api/login` -> start oauth
- `GET /api/login?switch=1` -> force account chooser
- `GET /api/callback` -> oauth callback
- `GET /api/recent` -> recent tracks json
- `GET /api/now-playing` -> currently playing json
- `GET /api/logout` -> clear session

## 🧠 session + data model

- no database is required for current version
- tokens are stored in encrypted signed cookies per user
- each browser session is isolated

## 🛠 troubleshooting

- `invalid redirect uri`:
make sure uri in spotify dashboard exactly matches `spotify_redirect_uri`
- auto-logged in unexpectedly:
you still have a valid session cookie, use `disconnect`
- now playing missing:
reconnect once after scope updates so spotify grants new permission

## 📄 license

MIT
