# YouTube OAuth 2.0 setup (step by step)

This walkthrough gets the factory permission to read comments from **your own channel** and publish
Shorts to it. It uses the official YouTube Data API v3 and a standard web-application OAuth client.

## 1. Google Cloud project

1. Go to <https://console.cloud.google.com/>.
2. Top bar → project selector → **New project** (e.g. `shorts-factory`).
3. Wait for creation, then make sure the new project is selected.

## 2. Enable the API

1. **APIs & Services → Library**.
2. Search for **YouTube Data API v3** → **Enable**.

Without this step every API call fails with `accessNotConfigured`.

## 3. OAuth consent screen

1. **APIs & Services → OAuth consent screen**.
2. User type **External** (Internal only works for Workspace organisations).
3. App information: name, user support email, developer contact email. A logo is optional.
4. **Scopes** → add:
   - `https://www.googleapis.com/auth/youtube.readonly`
   - `https://www.googleapis.com/auth/youtube.upload`
5. **Test users** → add the Google account that owns the channel.
6. Save. You can stay in *Testing* mode while developing; tokens for test users expire after about
   seven days, which is fine because the app stores a refresh token and re-consents when needed.

## 4. OAuth client

1. **APIs & Services → Credentials → Create credentials → OAuth client ID**.
2. Application type: **Web application**.
3. Authorised redirect URIs (exact match, no trailing slash mismatch):
   - `http://localhost:3000/auth/google/callback`
   - `https://your-domain.com/auth/google/callback`
4. Copy the **client id** and **client secret**.

```env
GOOGLE_CLIENT_ID=1234567890-abc.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-...
GOOGLE_REDIRECT_URI=http://localhost:3000/auth/google/callback
BASE_URL=http://localhost:3000
```

Restart the app after changing `.env`.

## 5. Connect the channel

1. Open the dashboard → **Settings**.
2. The *YouTube channel* card shows the redirect URI the app will use. It must match Google Cloud.
3. **Connect channel** → sign in with the channel account → approve both scopes.
4. You are redirected back to `/?connected=1`; the capability chip turns green and shows the channel
   name.

Behind the scenes:

```
/auth/google            → 302 to accounts.google.com (state cookie set)
/auth/google/callback   → exchanges code for tokens (offline access)
                        → channels.list?mine=true to record the channel id/name
                        → tokens stored in SQLite (oauth_tokens) — never in the browser
```

Tokens are refreshed automatically ~60 s before expiry. If the refresh token is revoked, jobs fail
with `auth_required` and the dashboard asks you to reconnect.

## 6. Alternative: import an existing token file

If you already have a token JSON (for example from a previous deployment or the OAuth Playground):

```bash
mkdir -p credentials
cp /secure/location/youtube-token.json credentials/youtube-token.json
node src/cli.js google-auth --import credentials/youtube-token.json
# prints the connected channel title
```

On boot the app also imports `credentials/youtube-token.json` automatically when no tokens are
stored. `credentials/` is git-ignored; file permissions should be `600`.

## 7. Scopes and what they allow

| Scope | Used for | Not used for |
|---|---|---|
| `youtube.readonly` | `channels.list`, `playlistItems.list`, `commentThreads.list` | reading other people's private data |
| `youtube.upload` | `videos.insert` with resumable upload | editing or deleting existing videos |

The app never requests broader scopes (no `youtube.force-ssl`, no Drive, no Gmail).

## 8. Quota and publishing limits

- Reads share a **10,000 units/day** bucket. `commentThreads.list` costs 1 unit per page.
- Uploads have their own bucket: **100 calls/day, 1 unit each** under the current API rules.
  Projects created earlier may still pay ~1600 units from the shared pool — set
  `YOUTUBE_UPLOAD_USES_SHARED_QUOTA=true` if you see that behaviour in your quota dashboard.
- Quota resets at **midnight Pacific Time**.
- Unverified OAuth apps: uploads may be forced to **private** until your app passes Google's
  compliance audit. The factory defaults to private and requires `ALLOW_PUBLIC_UPLOAD=true` before
  it will ever publish publicly.
- Respect YouTube's Terms of Service and Community Guidelines. Automated mass uploads of low-effort
  content can get a channel terminated — which is why daily limits, private-first defaults and
  artifact validation exist.

## 9. Verifying the connection without publishing

```bash
node src/cli.js doctor        # shows "YouTube OAuth connected: <channel>"
curl -s localhost:3000/api/settings -b cookie.txt | jq .youtube
```

Then create a job with `UPLOAD_PRIVACY=private` and `DAILY_UPLOAD_LIMIT=1`. Inspect the job drawer:
the upload stage records the returned video id and URL. Nothing else is published until you change
the privacy setting yourself.
