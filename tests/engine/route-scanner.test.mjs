import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { detectFramework, deriveFrontendRoot, deriveUrlFromPath, scanAllRoutes, scanDynamicRoutes, extractParamNames, buildDynamicUrlOverrides } from "../../src/engine/route-scanner.mjs";

function makeRoot(structure) {
  const root = join(tmpdir(), `route-scanner-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  for (const [rel, content] of Object.entries(structure)) {
    const full = join(root, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content ?? "");
  }
  return root;
}

// ── detectFramework ───────────────────────────────────────────────────────────

describe("detectFramework — package.json (primary)", () => {
  test("detects nextjs-app-router via package.json + src/app/ dir", () => {
    const root = makeRoot({
      "web/package.json": JSON.stringify({ dependencies: { next: "14.0.0" } }),
      "web/src/app/page.tsx": "",
    });
    expect(detectFramework(root, "web/")).toBe("nextjs-app-router");
  });

  test("detects nextjs-pages-router via package.json when src/app/ absent", () => {
    const root = makeRoot({
      "web/package.json": JSON.stringify({ dependencies: { next: "14.0.0" } }),
      "web/src/pages/index.tsx": "",
    });
    expect(detectFramework(root, "web/")).toBe("nextjs-pages-router");
  });

  test("detects nuxt via package.json", () => {
    const root = makeRoot({
      "web/package.json": JSON.stringify({ dependencies: { nuxt: "3.0.0" } }),
    });
    expect(detectFramework(root, "web/")).toBe("nuxt");
  });

  test("detects sveltekit via package.json", () => {
    const root = makeRoot({
      "web/package.json": JSON.stringify({ devDependencies: { "@sveltejs/kit": "2.0.0" } }),
    });
    expect(detectFramework(root, "web/")).toBe("sveltekit");
  });

  test("detects spa for react without next", () => {
    const root = makeRoot({
      "web/package.json": JSON.stringify({ dependencies: { react: "18.0.0" } }),
    });
    expect(detectFramework(root, "web/")).toBe("spa");
  });

  test("detects spa for vue without nuxt", () => {
    const root = makeRoot({
      "web/package.json": JSON.stringify({ dependencies: { vue: "3.0.0" } }),
    });
    expect(detectFramework(root, "web/")).toBe("spa");
  });

  test("detects spa for angular", () => {
    const root = makeRoot({
      "web/package.json": JSON.stringify({ dependencies: { "@angular/core": "17.0.0" } }),
    });
    expect(detectFramework(root, "web/")).toBe("spa");
  });

  test("uses devDependencies too", () => {
    const root = makeRoot({
      "web/package.json": JSON.stringify({ devDependencies: { nuxt: "3.0.0" } }),
    });
    expect(detectFramework(root, "web/")).toBe("nuxt");
  });
});

describe("detectFramework — filesystem fallback (no package.json)", () => {
  test("detects nextjs-app-router when src/app/ exists", () => {
    const root = makeRoot({ "web/src/app/page.tsx": "" });
    expect(detectFramework(root, "web/")).toBe("nextjs-app-router");
  });

  test("detects nextjs-pages-router when src/pages/ exists", () => {
    const root = makeRoot({ "web/src/pages/index.tsx": "" });
    expect(detectFramework(root, "web/")).toBe("nextjs-pages-router");
  });

  test("detects sveltekit when src/routes/ exists", () => {
    const root = makeRoot({ "web/src/routes/+page.svelte": "" });
    expect(detectFramework(root, "web/")).toBe("sveltekit");
  });

  test("detects nuxt when pages/ exists", () => {
    const root = makeRoot({ "web/pages/index.vue": "" });
    expect(detectFramework(root, "web/")).toBe("nuxt");
  });

  test("returns unknown for empty project", () => {
    const root = makeRoot({});
    expect(detectFramework(root, "web/")).toBe("unknown");
  });

  test("uses empty frontendRoot for monorepo root", () => {
    const root = makeRoot({ "src/app/page.tsx": "" });
    expect(detectFramework(root, "")).toBe("nextjs-app-router");
  });
});

// ── deriveFrontendRoot ────────────────────────────────────────────────────────

describe("deriveFrontendRoot", () => {
  test("returns web/ for typical nx workspace", () => {
    const config = { agents: { "frontend-subagent": { scope: ["web/src", "web/public"] } } };
    expect(deriveFrontendRoot(config)).toBe("web/src/");
  });

  test("ignores lib/ paths and returns first non-shared scope", () => {
    const config = { agents: { "frontend-subagent": { scope: ["libs/ui", "web/src"] } } };
    expect(deriveFrontendRoot(config)).toBe("web/src/");
  });

  test("returns empty string when no frontend scope", () => {
    const config = { agents: {} };
    expect(deriveFrontendRoot(config)).toBe("");
  });
});

// ── deriveUrlFromPath ─────────────────────────────────────────────────────────

describe("deriveUrlFromPath — nextjs-app-router", () => {
  test("page in route group", () => {
    expect(deriveUrlFromPath("web/src/app/(dashboard)/reports/page.tsx", "web/", "nextjs-app-router")).toBe("/reports");
  });

  test("page with dynamic segment", () => {
    expect(deriveUrlFromPath("web/src/app/(dashboard)/invoices/[id]/page.tsx", "web/", "nextjs-app-router")).toBe("/invoices/1");
  });

  test("page with catch-all segment", () => {
    expect(deriveUrlFromPath("web/src/app/(dashboard)/docs/[...slug]/page.tsx", "web/", "nextjs-app-router")).toBe("/docs/test");
  });

  test("root page", () => {
    expect(deriveUrlFromPath("web/src/app/page.tsx", "web/", "nextjs-app-router")).toBe("/");
  });

  test("layout.tsx returns null", () => {
    expect(deriveUrlFromPath("web/src/app/(dashboard)/layout.tsx", "web/", "nextjs-app-router")).toBeNull();
  });

  test("loading.tsx returns null", () => {
    expect(deriveUrlFromPath("web/src/app/(dashboard)/loading.tsx", "web/", "nextjs-app-router")).toBeNull();
  });

  test("non-app-router path returns null", () => {
    expect(deriveUrlFromPath("web/src/components/Button.tsx", "web/", "nextjs-app-router")).toBeNull();
  });
});

describe("deriveUrlFromPath — nextjs-pages-router", () => {
  test("standard page", () => {
    expect(deriveUrlFromPath("web/src/pages/reports.tsx", "web/", "nextjs-pages-router")).toBe("/reports");
  });

  test("index page", () => {
    expect(deriveUrlFromPath("web/src/pages/invoices/index.tsx", "web/", "nextjs-pages-router")).toBe("/invoices");
  });

  test("_app.tsx returns null", () => {
    expect(deriveUrlFromPath("web/src/pages/_app.tsx", "web/", "nextjs-pages-router")).toBeNull();
  });
});

describe("deriveUrlFromPath — nuxt", () => {
  test("index page", () => {
    expect(deriveUrlFromPath("web/pages/index.vue", "web/", "nuxt")).toBe("/");
  });

  test("standard page", () => {
    expect(deriveUrlFromPath("web/pages/invoices.vue", "web/", "nuxt")).toBe("/invoices");
  });
});

describe("deriveUrlFromPath — sveltekit", () => {
  test("standard route", () => {
    expect(deriveUrlFromPath("web/src/routes/reports/+page.svelte", "web/", "sveltekit")).toBe("/reports");
  });

  test("root route", () => {
    expect(deriveUrlFromPath("web/src/routes/+page.svelte", "web/", "sveltekit")).toBe("/");
  });
});

// ── scanAllRoutes ─────────────────────────────────────────────────────────────

describe("scanAllRoutes", () => {
  test("returns all routes for nextjs-app-router project", () => {
    const root = makeRoot({
      "web/src/app/(dashboard)/reports/page.tsx": "",
      "web/src/app/(dashboard)/invoices/page.tsx": "",
      "web/src/app/(dashboard)/layout.tsx": "",
      "web/src/app/page.tsx": "",
    });
    const { urls } = scanAllRoutes(root, "web/", "nextjs-app-router");
    expect(urls).toContain("/reports");
    expect(urls).toContain("/invoices");
    expect(urls).toContain("/");
    expect(urls).not.toContain("/layout");
  });

  test("returns empty arrays for unknown framework", () => {
    const root = makeRoot({});
    expect(scanAllRoutes(root, "web/", "unknown")).toEqual({ urls: [], dynamicUrls: [] });
  });

  test("returns sorted deduplicated routes", () => {
    const root = makeRoot({
      "web/src/app/(dashboard)/b/page.tsx": "",
      "web/src/app/(dashboard)/a/page.tsx": "",
    });
    const { urls } = scanAllRoutes(root, "web/", "nextjs-app-router");
    expect(urls).toEqual([...urls].sort());
    expect(new Set(urls).size).toBe(urls.length);
  });

  test("per-route override wins over flat name default when both configured", () => {
    const root = makeRoot({
      "web/src/app/(dashboard)/clients/[id]/page.tsx": "",
      "web/src/app/(dashboard)/invoices/[id]/page.tsx": "",
    });
    const routeParams = {
      id: "1",                                  // flat default — would collide across both routes
      "/clients/[id]": { id: "demo-client-1" }, // override wins for this route only
    };
    const { urls } = scanAllRoutes(root, "web/", "nextjs-app-router", routeParams);
    expect(urls).toContain("/clients/demo-client-1");
    expect(urls).toContain("/invoices/1"); // falls back to flat default, no override configured
  });

  test("flags dynamic-segment routes and substitutes routeParams by name", () => {
    const root = makeRoot({
      "web/src/app/(dashboard)/clients/[id]/page.tsx": "",
      "web/src/app/(dashboard)/docs/[...slug]/page.tsx": "",
      "web/src/app/(dashboard)/reports/page.tsx": "",
    });
    const { urls, dynamicUrls } = scanAllRoutes(root, "web/", "nextjs-app-router", { id: "42" });
    expect(urls).toContain("/clients/42");
    expect(urls).toContain("/docs/test");
    expect(dynamicUrls).toEqual(["/clients/42", "/docs/test"]);
    expect(dynamicUrls).not.toContain("/reports");
  });
});

describe("extractParamNames", () => {
  test("extracts a single named segment", () => {
    expect(extractParamNames("clients/[id]")).toEqual(["id"]);
  });

  test("extracts a catch-all segment by its inner name, without the leading dots", () => {
    expect(extractParamNames("docs/[...slug]")).toEqual(["slug"]);
  });

  test("extracts multiple named segments in order", () => {
    expect(extractParamNames("orgs/[orgId]/projects/[projectId]")).toEqual(["orgId", "projectId"]);
  });

  test("returns an empty array for a static route", () => {
    expect(extractParamNames("reports")).toEqual([]);
  });
});

describe("scanDynamicRoutes", () => {
  test("returns one entry per distinct dynamic route pattern with its param names and a live example URL", () => {
    const root = makeRoot({
      "web/src/app/(dashboard)/clients/[id]/page.tsx": "",
      "web/src/app/(dashboard)/docs/[...slug]/page.tsx": "",
      "web/src/app/(dashboard)/reports/page.tsx": "",
    });
    const routes = scanDynamicRoutes(root, "web/", "nextjs-app-router");
    expect(routes).toEqual([
      { routePattern: "/clients/[id]", paramNames: ["id"], exampleUrl: "/clients/1" },
      { routePattern: "/docs/[...slug]", paramNames: ["slug"], exampleUrl: "/docs/test" },
    ]);
  });

  test("returns an empty array when no dynamic routes exist", () => {
    const root = makeRoot({ "web/src/app/reports/page.tsx": "" });
    expect(scanDynamicRoutes(root, "web/", "nextjs-app-router")).toEqual([]);
  });

  test("returns an empty array for an unknown framework", () => {
    const root = makeRoot({});
    expect(scanDynamicRoutes(root, "web/", "unknown")).toEqual([]);
  });
});

// ── buildDynamicUrlOverrides ────────────────────────────────────────────────────

describe("buildDynamicUrlOverrides", () => {
  test("maps the LLM's generic placeholder to the routeParams-resolved URL", () => {
    const changedFiles = ["web/src/app/(dashboard)/clients/[id]/page.tsx"];
    const routeParams = { id: "demo-client-1" };
    const overrides = buildDynamicUrlOverrides(changedFiles, "web/", "nextjs-app-router", routeParams);
    expect(overrides.get("/clients/1")).toBe("/clients/demo-client-1");
  });

  test("prefers a route-specific override over the flat default", () => {
    const changedFiles = ["web/src/app/(dashboard)/clients/[id]/page.tsx"];
    const routeParams = { id: "flat-default", "/clients/[id]": { id: "specific-client" } };
    const overrides = buildDynamicUrlOverrides(changedFiles, "web/", "nextjs-app-router", routeParams);
    expect(overrides.get("/clients/1")).toBe("/clients/specific-client");
  });

  test("returns no mapping when no routeParams are configured", () => {
    const changedFiles = ["web/src/app/(dashboard)/clients/[id]/page.tsx"];
    const overrides = buildDynamicUrlOverrides(changedFiles, "web/", "nextjs-app-router", {});
    expect(overrides.size).toBe(0);
  });

  test("ignores static page files and non-page files", () => {
    const changedFiles = [
      "web/src/app/(dashboard)/reports/page.tsx",
      "web/src/components/nav-bar.tsx",
    ];
    const overrides = buildDynamicUrlOverrides(changedFiles, "web/", "nextjs-app-router", { id: "demo-client-1" });
    expect(overrides.size).toBe(0);
  });
});
