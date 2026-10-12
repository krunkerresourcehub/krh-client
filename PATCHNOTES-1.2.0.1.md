# KRH Client 1.2.0.1

## Fixed
- **Google / Discord login on the website now finishes inside KRH Client.** Before, "Continue with Google / Discord" opened the browser and the login stayed there, so the client was never logged in.

## Changed
- Login, sign up and **Link account** (Account Settings) open your normal browser, as before.
- After you sign in, the browser page asks you to **go back to KRH Client** ("Open KRH Client"). The client then finishes the login, sign up or account link by itself.
- Works even if KRH Client was closed in the meantime: opening the link starts it and completes the sign-in.
- A normal browser (not started from the client) behaves exactly as before.

## Security
- The sign-in uses PKCE: the one-time code shown in the browser only works in the client that started the login. Expired or foreign codes are rejected.
- Only well-formed `krh://auth` links are accepted; they never reach the game window.

## Notes for the site owner
- Add `https://<your-site>/community/client-return.html` to Supabase -> Authentication -> URL Configuration -> **Redirect URLs**. Without it the browser login still works but cannot hand back to the client.
- Version is now `1.2.0.1` (installer names: `KRH Client-1.2.0.1-Setup.exe`, `KRH Client-1.2.0.1-Portable.exe`).
