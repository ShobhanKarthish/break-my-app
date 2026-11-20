# Finding routes in the repo

The goal is a complete `routes.json`: pages the crawler cannot reach by following links,
and every API route, with the HTTP methods each one handles. Ten minutes of reading here
is what separates this skill from a blind crawler, because the routes nobody links to are
the ones nobody tested.

Framework conventions change between versions. Treat the table as where to start looking,
then confirm against the files actually in the repo.

| Stack | Pages | API routes |
|---|---|---|
| Next.js (app router) | `app/**/page.{tsx,jsx}`; folder path is the URL, `(group)` folders are not part of it | `app/**/route.{ts,js}`; exported `GET`, `POST`… functions are the methods. Server actions have no URL: they are exercised through their forms. |
| Next.js (pages router) | `pages/**/*.{tsx,jsx}` except `_app`, `_document`, `api/` | `pages/api/**`; methods are whatever the handler branches on |
| Remix / React Router framework mode | `app/routes/**` or `routes.ts` | Routes exporting `loader` (GET) / `action` (writes) with no default component |
| SvelteKit | `src/routes/**/+page.svelte` | `src/routes/**/+server.{ts,js}` |
| Nuxt | `pages/**/*.vue` | `server/api/**`, `server/routes/**`; the method may be in the filename (`users.post.ts`) |
| Astro | `src/pages/**/*.{astro,md,mdx}` | `src/pages/**/*.{ts,js}` exporting `GET`, `POST`… |
| Vite / CRA single-page app | The router config (`createBrowserRouter`, `<Route path=…>`) | A separate server: see the next rows |
| Express / Fastify / Hono / Koa | Rarely any | Search for `.get(`, `.post(`, `.put(`, `.patch(`, `.delete(`, and `router.use(` / `app.route(` prefixes |
| Django | `urls.py` → `urlpatterns` | Same, plus DRF routers (`router.register`) |
| Rails | `config/routes.rb` (or run `bin/rails routes`) | Same |
| FastAPI / Flask | Rarely any | `@app.get(…)`, `@router.post(…)`, `@app.route(…)`; FastAPI also serves `/openapi.json` |

## Practical notes

- **Search beats browsing.** One search for the route-defining pattern across the repo is
  faster and more complete than walking folders.
- **Dynamic segments** (`[id]`, `:id`, `<int:pk>`): substitute a value that exists. Look
  in seed scripts, fixtures or migrations; if the database is SQLite, a quick query is
  fine. If you cannot find a real value, leave the route out and list it under
  "Not covered" rather than probing a made-up id (a 404 there proves nothing).
- **Prefixes:** an Express router mounted with `app.use('/api/v1', router)` puts every
  route in that file under the prefix. Next.js `basePath` and proxy rewrites do the same.
- **API on another port:** if the frontend calls `http://localhost:8000` while the pages
  are on `:3000`, the harness's API sweep only covers the origin it was pointed at. Run
  it a second time with `--url` set to the API's address and `--packs api`.
- **Prioritise** when there are more than about forty API routes: anything touching
  users, accounts, payments, orders, files or admin first.
- **Leave out** logout, delete-account and similar pages from `pages`. The crawler skips
  links that look destructive, and listing them by hand overrides that.
