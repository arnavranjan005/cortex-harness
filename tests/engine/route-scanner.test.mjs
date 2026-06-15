import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { detectFramework, deriveFrontendRoot, deriveUrlFromPath, scanAllRoutes } from "../../src/engine/route-scanner.mjs";

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
    const routes = scanAllRoutes(root, "web/", "nextjs-app-router");
    expect(routes).toContain("/reports");
    expect(routes).toContain("/invoices");
    expect(routes).toContain("/");
    expect(routes).not.toContain("/layout");
  });

  test("returns empty array for unknown framework", () => {
    const root = makeRoot({});
    expect(scanAllRoutes(root, "web/", "unknown")).toEqual([]);
  });

  test("returns sorted deduplicated routes", () => {
    const root = makeRoot({
      "web/src/app/(dashboard)/b/page.tsx": "",
      "web/src/app/(dashboard)/a/page.tsx": "",
    });
    const routes = scanAllRoutes(root, "web/", "nextjs-app-router");
    expect(routes).toEqual([...routes].sort());
    expect(new Set(routes).size).toBe(routes.length);
  });
});
