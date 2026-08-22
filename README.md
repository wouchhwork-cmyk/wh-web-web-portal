# wh-web-web-portal

The web front end for [`wh-api-unified-service`](../wh-api-unified-service).

Plain HTML, CSS and vanilla JavaScript. **No build step, no framework, no
dependencies** — deliberately. The job right now is to prove the API flows work
end to end: signing up a business, verifying a code, signing in, and the internal
admin console that activates businesses. It will be rebuilt properly once those
flows are settled, so nothing here is written to last.

## Running it

The API has to be up first:

```bash
cd ../wh-api-unified-service
pnpm build && pnpm start:local        # http://localhost:3000
```

Then this:

```bash
node server.js                        # http://localhost:5173
```

`file://` will not work. The API is a credentialed CORS endpoint and a `file://`
page has the opaque `null` origin, which CORS can never allow — so the portal
needs a real origin, which is all `server.js` provides.

The port matters: `5173` must appear in the API's `CORS_ORIGINS`.

## Pages

| Page | What it does |
| --- | --- |
| `index.html` | Sign in, by mobile or email. Handles all three login outcomes: straight in, code required, or choose between several businesses. |
| `signup.html` | Create a business account. Ends in a verification challenge — signup never issues a session. |
| `verify.html` | Enter the code, against the opaque `verificationRefId` the previous step returned. Never sends the address again. |
| `admin.html` | Internal console. Every business, its counts and what it has configured; activate or suspend; grant, disable, decline or revoke features. |
| `portal.html` | What a business owner sees. Today that is mainly their activation state, which is the point: an owner waiting on us should be told so, not shown an app whose every button returns 403. |

## Signing in

**As a business:** whatever you signed up with.

**As the platform admin:** the credential in the API's `PLATFORM_ADMIN_*`
environment variables. In development that is mobile `8408994828` with password
`1234`. There is no staff signup page and there never will be — a self-service
route to a staff account would be the worst hole in the product, so internal
accounts are provisioned from the deployment environment only.

## The verification code in development

While the API runs with `OTP_REALTIME_ENABLED=false`, nothing is sent anywhere and
every issued code is the fixed `OTP_STATIC_CODE` (`666666`). The code screen
pre-fills it, driven by `devOtpHint` in `config.js`.

Blank `devOtpHint` the moment a real SMS or email provider is wired up. The API
refuses to boot in production with the static code enabled, so the two cannot
drift apart in the direction that would matter.

## Configuration

Everything environment-specific is in `config.js`:

| Key | Meaning |
| --- | --- |
| `apiBaseUrl` | Where the API is. Must be an origin the API allows. |
| `devOtpHint` | The fixed development code to pre-fill. Blank in any real environment. |

## How the session is held

The access token goes in `sessionStorage` — per tab, and gone when the tab
closes. The refresh token is never visible to this code at all: the API sets it
as an `httpOnly` cookie, which is why every request is sent with
`credentials: 'include'`.

A 401 sends the person back to sign in. Silent refresh is not wired up yet.
