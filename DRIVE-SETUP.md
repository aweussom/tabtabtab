# Drive sync — Google Cloud OAuth setup

One-time setup to enable cross-device sync of UG imports via the user's own Google Drive. The flow uses Drive's hidden `appDataFolder` scope — each app only sees its own files, invisible in the user's normal Drive UI.

The Client ID is **public information** (it's just a routing identifier). There is no client secret in this flow — modern browser apps don't use one. So the Client ID lives hardcoded in `drive-sync.js` and gets committed.

## Steps

1. **Go to Google Cloud Console**: <https://console.cloud.google.com/>

2. **Create a project** (or use existing):
   - Top-left project selector → "New Project"
   - Name: `tabtabtab` (or whatever)
   - Click "Create"

3. **Enable the Drive API**:
   - Hamburger menu → "APIs & Services" → "Library"
   - Search "Google Drive API" → click → "Enable"

4. **Configure the OAuth consent screen**:
   - Hamburger menu → "APIs & Services" → "OAuth consent screen"
   - User Type: **External** (unless you're on a Google Workspace org with internal-only)
   - Click "Create"
   - App name: `TabTabTab`
   - User support email: your email
   - Developer contact: your email
   - "Save and Continue"
   - **Scopes step**: click "Add or Remove Scopes" → search `drive.appdata` → tick `auth/drive.appdata` (the *App data* scope — non-sensitive). Save → Continue.
   - **Test users**: add your own Google account(s) while the app is in "Testing" mode. You can verify later if you want public access. Save → Continue.
   - Review → "Back to Dashboard"

5. **Create the OAuth Client ID**:
   - Hamburger menu → "APIs & Services" → "Credentials"
   - "Create Credentials" → "OAuth client ID"
   - Application type: **Web application**
   - Name: `tabtabtab web client`
   - **Authorized JavaScript origins** — add each origin you'll serve the app from:
     - `http://localhost:8765` (or whatever port you use for `python -m http.server`)
     - `https://tabtabtab.no` (production, when live)
     - Add more as needed (e.g. a staging URL)
   - **Authorized redirect URIs**: leave empty for now — Google Identity Services (GIS) token flow doesn't use them. Add the origins again here if Google complains.
   - Click "Create"
   - **Copy the Client ID** that pops up (something like `123456789-abcdefg.apps.googleusercontent.com`)

6. **Paste into `drive-sync.js`**:
   - Open `drive-sync.js` at the top
   - Replace the `CLIENT_ID` placeholder with your value
   - Commit (pre-commit hook will bump `version.js` automatically so the SW cache rolls)

7. **Test**:
   - Reload the app
   - Click the Drive sign-in button (wherever we wire it — initially probably in `#/songbooks` or a settings view)
   - Approve the consent screen
   - The first sync should write a `tabtabtab-local-imports.json` file to your hidden Drive `appDataFolder` (you can verify by visiting <https://drive.google.com/drive/u/0/settings> → "Manage apps", or via the Drive API explorer)

## Notes

- **Verification (for non-test users)**: The `drive.appdata` scope is a *non-sensitive* scope, so it does NOT require Google's verification process. You can publish the app without going through verification — friends/family/anyone with the link can sign in directly. (Sensitive scopes like full Drive access *do* require verification, but we deliberately use the minimal `appdata` scope to skip that.)
- **Quota**: free tier covers anything we'd reasonably need (Drive API has very high default quotas).
- **Privacy**: we (the tabtabtab maintainers) never see the user's tabs. The Drive blob is between Google and the user's account. No infra on our side.
