import { mergeProbeUrls } from "../../src/engine/probe-urls.mjs";

describe("mergeProbeUrls", () => {
  test("returns detected when smokeUrls is empty", () => {
    const { merged, appended } = mergeProbeUrls(["/reports", "/invoices"], []);
    expect(merged).toEqual(["/reports", "/invoices"]);
    expect(appended).toEqual([]);
  });

  test("returns smokeUrls when detected is empty", () => {
    const { merged, appended } = mergeProbeUrls([], ["/reports", "/invoices"]);
    expect(merged).toEqual(["/reports", "/invoices"]);
    expect(appended).toEqual(["/reports", "/invoices"]);
  });

  test("appends smokeUrls that are not already detected", () => {
    const { merged, appended } = mergeProbeUrls(["/reports"], ["/invoices", "/customers"]);
    expect(merged).toEqual(["/reports", "/invoices", "/customers"]);
    expect(appended).toEqual(["/invoices", "/customers"]);
  });

  test("deduplicates URLs present in both detected and smokeUrls", () => {
    const { merged, appended } = mergeProbeUrls(["/reports", "/invoices"], ["/invoices", "/customers"]);
    expect(merged).toEqual(["/reports", "/invoices", "/customers"]);
    expect(appended).toEqual(["/customers"]);
    expect(merged.filter(u => u === "/invoices")).toHaveLength(1);
  });

  test("deduplicates all smokeUrls when all already detected", () => {
    const { merged, appended } = mergeProbeUrls(["/reports", "/invoices"], ["/reports", "/invoices"]);
    expect(merged).toEqual(["/reports", "/invoices"]);
    expect(appended).toEqual([]);
  });

  test("returns empty when both inputs are empty", () => {
    const { merged, appended } = mergeProbeUrls([], []);
    expect(merged).toEqual([]);
    expect(appended).toEqual([]);
  });

  test("handles undefined inputs with defaults", () => {
    const { merged, appended } = mergeProbeUrls(undefined, undefined);
    expect(merged).toEqual([]);
    expect(appended).toEqual([]);
  });

  test("preserves detected order, appended follow in smokeUrls order", () => {
    const { merged } = mergeProbeUrls(["/b", "/a"], ["/c", "/d"]);
    expect(merged).toEqual(["/b", "/a", "/c", "/d"]);
  });
});
