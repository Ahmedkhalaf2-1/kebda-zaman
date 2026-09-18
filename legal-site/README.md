# Kebda Zaman Legal Site

A static legal information site for the Kebda Zaman restaurant ordering app: Privacy Policy, Terms of Service, and an Account Deletion page, in English and Arabic.

## Production domain

`https://legal.kebdazaman.cloud`

## Expected routes

| Route | File served |
|---|---|
| `/` | `index.html` |
| `/privacy` | `privacy.html` |
| `/terms` | `terms.html` |
| `/delete-account` | `delete-account.html` |

Clean-URL rewriting (`/privacy` → `privacy.html`, etc.) is handled by the web server — see `Caddyfile.snippet`. Opening the `.html` files directly also works.

## Support email

`bodymoka8@gmail.com` — used throughout the site for privacy questions, terms questions, and account deletion requests.

## Architecture

- **Static only.** Plain HTML, CSS, and vanilla JavaScript. No build step, no framework, no npm dependencies.
- **No backend dependency.** This site makes no calls to the Kebda Zaman NestJS API and has no database access. It can be deployed and served completely independently of the backend.
- **No third parties.** No analytics, no tracking, no advertising, no external fonts, no CDNs, no cookies. `localStorage` is used for exactly one thing: remembering the visitor's chosen language (`en`/`ar`).
- **Language switching.** `script.js` detects the browser language on first visit (Arabic if `navigator.language` starts with `ar`, English otherwise), and lets the visitor override it with the EN / العربية buttons in the header. The choice is remembered in `localStorage` and applied via `document.documentElement.lang` / `dir`.
- **The only outbound action** a visitor can take is a `mailto:` link (support contact, and the account-deletion request on `delete-account.html`).

## Local preview

From the repository root:

```bash
python3 -m http.server 8081 --directory legal-site
```

Then open `http://localhost:8081/` (or `/privacy.html`, `/terms.html`, `/delete-account.html`) in a browser.

## How Caddy is intended to serve this in production

`Caddyfile.snippet` in this directory documents (but does not apply) the intended Caddy v2 site block: it serves this directory as static files for `legal.kebdazaman.cloud` and rewrites `/privacy`, `/terms`, and `/delete-account` to their corresponding `.html` files.

Deployment is a separate, deliberate step and must only happen after this branch has been committed, pushed, reviewed, and approved:

1. Sync this `legal-site/` directory to the production path referenced in `Caddyfile.snippet` (`/opt/kebda-zaman/legal-site`).
2. Add the reviewed block from `Caddyfile.snippet` into the real `/etc/caddy/Caddyfile` on the VPS.
3. Reload Caddy.

**Never edit the production Caddy configuration directly from a local session.** `Caddyfile.snippet` is reference documentation only.
