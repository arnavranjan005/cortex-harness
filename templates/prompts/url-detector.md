You are a URL extractor. Read the files below and print JSON output only — no explanation, no markdown, no file writes. Print the JSON as your entire response.

The changed files for this run are provided inline — do NOT read changed-files.json from disk:

```json
{{CHANGED_FILES_JSON}}
```

**FRONTEND_ROOT for this project: `{{FRONTEND_ROOT}}`**
Use this as the path prefix when constructing any file paths below. If empty, paths start from the repo root.

**FRAMEWORK for this project: `{{FRAMEWORK}}`**
The engine has already detected this from the filesystem. Use it directly — do not re-detect from changed files.

---

## Step 1 — Framework routing

Framework is `{{FRAMEWORK}}` (pre-detected by engine).

For **file-based frameworks** (`nextjs-app-router`, `nextjs-pages-router`, `nuxt`, `sveltekit`): go to Step 2 then Step 2b.
For **spa** or **unknown**: skip Step 2, go directly to Step 2b then Step 3.

---

## Step 2 — File-based routing URL derivation

*(File-based frameworks only — spa skips this step)*

Strip FRONTEND_ROOT from each path before applying these rules.

**Next.js app router:**
- `src/app/(any-route-group)/X/page.tsx` → `/X`
- `src/app/X/page.tsx` (no route group) → `/X`
- `src/app/(any-route-group)/X/[param]/page.tsx` → `/X/1`, mark **isDynamic: true**
- `src/app/(any-route-group)/X/[...slug]/page.tsx` → `/X/test`, mark **isDynamic: true**
- Any `layout.tsx` changed (any path, any nesting) → set `layoutAffected: true`

**Next.js pages router:**
- `src/pages/X.tsx` → `/X`
- `src/pages/X/index.tsx` → `/X`
- `src/pages/[param].tsx` or `src/pages/X/[param].tsx` → mark **isDynamic: true**
- `src/pages/_app.tsx` or `src/pages/_document.tsx` → set `layoutAffected: true`

**Nuxt:**
- `pages/X.vue` → `/X`
- `pages/index.vue` → `/`
- `pages/[param].vue` → mark **isDynamic: true**
- Any file under `layouts/` changed (any filename, not just `default.vue`/`app.vue`) → set `layoutAffected: true`

**SvelteKit:**
- `src/routes/X/+page.svelte` → `/X`
- `src/routes/X/[param]/+page.svelte` → mark **isDynamic: true**
- Any `+layout.svelte` changed (any path, any nesting — not just the root) → set `layoutAffected: true`

For every URL, set `isDynamic: false` unless one of the dynamic-segment rules above applies. Always substitute the generic placeholder (`1` for `[param]`, `test` for `[...slug]`) yourself — you have no knowledge of project-specific route param values; the engine resolves those mechanically afterward using the `isDynamic` flag you set.

---

## Step 2b — Shared dependency cross-reference

Run this step for ANY changed file in `hooks/`, `components/`, `context/`, `lib/`, `utils/`, or `store/`.

**2b-1. Extract base name** — filename without extension and without path:
- `web/src/hooks/use-push-notifications.ts` → `use-push-notifications`
- `src/components/nav-bar.tsx` → `nav-bar`

**2b-2. Find and read the root layout/shell file** using FRONTEND_ROOT and the detected framework. Try each candidate in order, stop at the first readable file:

- **nextjs-app-router** (try route-group names: `dashboard`, `main`, `app`, `root`, `protected`, `private`, `authenticated`):
  - `{FRONTEND_ROOT}src/app/(dashboard)/layout.tsx`
  - `{FRONTEND_ROOT}src/app/(main)/layout.tsx`
  - `{FRONTEND_ROOT}src/app/(app)/layout.tsx`
  - `{FRONTEND_ROOT}src/app/(root)/layout.tsx`
  - `{FRONTEND_ROOT}src/app/(protected)/layout.tsx`
  - `{FRONTEND_ROOT}src/app/layout.tsx`

- **nextjs-pages-router**:
  - `{FRONTEND_ROOT}src/pages/_app.tsx`
  - `{FRONTEND_ROOT}src/pages/_app.js`

- **nuxt**:
  - `{FRONTEND_ROOT}layouts/default.vue`
  - `{FRONTEND_ROOT}layouts/app.vue`

- **sveltekit**:
  - `{FRONTEND_ROOT}src/routes/+layout.svelte`

- **spa**:
  - `{FRONTEND_ROOT}src/App.tsx`
  - `{FRONTEND_ROOT}src/App.jsx`
  - `{FRONTEND_ROOT}src/main.tsx`

**2b-3. Check for import** — if the layout/shell file contains the base name (from 2b-1) as a string → set `layoutAffected: true`, then:
- Framework is **file-based** → output `urls: []` and stop (Step 5)
- Framework is **spa** → continue to Step 3 with `extractAll: true`

**2b-4. If `layoutAffected` is false** (hook/component not found in layout):
- Derive candidate page paths from the base name's domain keywords
  (e.g. `use-push-notifications` → `notifications`, `push`, `settings`; `invoice-form` → `invoices`, `billing`)
- Build at most 3 candidate page file paths using FRONTEND_ROOT + framework pattern + guessed directory name
- Read each candidate. If it contains the base name as an import → add that URL to `urls[]`
- If no match after 3 tries → add `"/"` as a conservative fallback

---

## Step 3 — Code-based routing (spa)

*(When entered from Step 2b with `extractAll: true`, extract ALL routes. Otherwise extract only routes relevant to changed files.)*

**3a. Find the router definition file** — prefix all paths with FRONTEND_ROOT. Try in order:
- `src/router.tsx`, `src/router.ts`, `src/router/index.tsx`, `src/router/index.ts`
- `src/routes.tsx`, `src/routes.ts`, `src/routes/index.tsx`, `src/routes/index.ts`
- `src/App.tsx`, `src/App.ts`
- `src/main.tsx`, `src/main.ts`

**3b. Extract route paths.**
Look for string literals in these patterns:
- `path: "/foo"` or `path: 'foo'` (React Router v6 object syntax)
- `path="/foo"` or `path='/foo'` (JSX Route element)
- `{ path: "foo", ... }` (TanStack Router, React Router loaders)
- `to="/foo"` on `<Link>` or `<NavLink>` — hint only, use if no route definitions found

Rules:
- Normalize: add leading `/` if missing
- Dynamic segments (`:id`, `$id`, `[id]`) → replace with `1`, mark **isDynamic: true** for that URL
- Wildcard `*` or `**` → skip
- Index routes (`index: true` or `path: ""` under a parent) → use the parent path
- Catch-all / not-found routes (`path: "*"`, `path: "404"`) → skip
- Deduplicate
- If `extractAll: true` → include every route found. Otherwise → include only routes whose component file name matches a changed file.

**3c. Cross-reference with changed files** *(skip if `extractAll: true`)*
If changed files include components in `pages/`, `views/`, `screens/`, or `features/` directories, check if their names suggest a route (e.g. `ReportsPage.tsx` → `/reports`). Include if not already in the list.

---

## Step 4 — Skip rules (apply to all frameworks)

Do NOT emit a URL for:
- Files in `components/`, `hooks/`, `utils/`, `lib/`, `styles/`, `types/`, `store/`, `context/` — **handled in Step 2b**
- Files ending in `.spec.`, `.test.`, `.stories.`
- API routes: `route.ts`, `api/` directories, `server/`
- Config files: `next.config.*`, `vite.config.*`, `tailwind.config.*`, `jest.config.*`, etc.
- Backend files (any path containing `api/src/`, `server/src/`, `functions/src/`)

---

## Step 5 — Output

Print this JSON as your entire response (no Write tool, no markdown fences in the final output):
```json
{
  "urls": [
    { "url": "/reports", "isDynamic": false },
    { "url": "/invoices/1", "isDynamic": true }
  ],
  "layoutAffected": false,
  "framework": "nextjs-app-router"
}
```

`framework` must be one of: `nextjs-app-router`, `nextjs-pages-router`, `nuxt`, `sveltekit`, `spa`, `unknown`

`isDynamic` must be `true` only for URLs produced by substituting a placeholder into a `[param]`/`[...slug]`/`:id`/`$id` segment (see Step 2/Step 3 rules) — `false` for every static route. Do not attempt to resolve a "real" value for dynamic segments yourself; the engine substitutes any configured `routeParams` override after the fact based on this flag.

If no page files changed and no routes extracted: `{ "urls": [], "layoutAffected": false, "framework": "detected-framework" }`
