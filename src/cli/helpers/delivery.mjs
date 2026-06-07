import fs from "fs-extra";
import path from "path";

export async function findLatestDelivery(cwd) {
  const outputDir = path.join(cwd, ".harness", "output");
  if (!(await fs.pathExists(outputDir))) return null;
  const files = (await fs.readdir(outputDir))
    .filter((f) => f.startsWith("delivery-") && f.endsWith(".md"))
    .sort(); // ISO timestamps sort lexicographically
  if (!files.length) return null;
  return path.join(outputDir, files[files.length - 1]);
}

export function findResidualRisksSection(markdown) {
  const h2Idx = markdown.indexOf("## Residual risks");
  const h3Idx = markdown.indexOf("### Residual risks");
  const sectionIdx =
    h2Idx === -1 ? h3Idx : h3Idx === -1 ? h2Idx : Math.min(h2Idx, h3Idx);
  if (sectionIdx === -1) return null;
  const heading =
    markdown[sectionIdx + 2] === "#"
      ? "### Residual risks"
      : "## Residual risks";
  const sectionStart = sectionIdx + heading.length;
  const nextHeading = markdown.slice(sectionStart).search(/^#{2,3} /m);
  return nextHeading === -1
    ? markdown.slice(sectionStart)
    : markdown.slice(sectionStart, sectionStart + nextHeading);
}
