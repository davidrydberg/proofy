// Renders overview.html frame by frame into docs/overview.gif, and flow.mmd into docs/flow.png.
// Usage: node docs/overview/render.mjs   (needs ffmpeg, Playwright's Chromium and internet for Mermaid)
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";

const FPS = 15;
const MERMAID = "https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.min.js";
const here = fileURLToPath(new URL(".", import.meta.url));
const docs = join(here, "..");

async function renderGif(browser) {
  const frames = mkdtempSync(join(tmpdir(), "proofy-overview-"));
  try {
    const page = await browser.newPage({ viewport: { width: 960, height: 540 }, deviceScaleFactor: 2 });
    await page.goto(pathToFileURL(join(here, "overview.html")).href);
    const duration = await page.evaluate(() => globalThis.DURATION);
    const count = Math.round(duration * FPS);
    for (let i = 0; i < count; i++) {
      await page.evaluate((t) => globalThis.render(t), i / FPS);
      await page.screenshot({ path: join(frames, `${String(i).padStart(4, "0")}.png`) });
    }
    execFileSync("ffmpeg", [
      "-y", "-loglevel", "error", "-framerate", String(FPS), "-i", join(frames, "%04d.png"),
      "-vf", "scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle",
      "-loop", "0", join(docs, "overview.gif"),
    ]);
  } finally {
    rmSync(frames, { recursive: true, force: true });
  }
}

async function renderFlow(browser) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 2 });
  await page.setContent(`<body style="margin:0;background:#181818"><pre class="mermaid" id="flow" style="display:inline-block;margin:0;padding:24px"></pre></body>`);
  await page.addScriptTag({ url: MERMAID });
  await page.evaluate(async (source) => {
    globalThis.document.getElementById("flow").textContent = source;
    globalThis.mermaid.initialize({
      startOnLoad: false,
      securityLevel: "loose",
      markdownAutoWrap: false,
      theme: "base",
      flowchart: { curve: "basis", padding: 14, useMaxWidth: false, wrappingWidth: 600 },
      themeVariables: {
        fontFamily: "-apple-system, Segoe UI, Helvetica, Arial, sans-serif",
        fontSize: "15px",
        background: "#181818",
        primaryColor: "#232323",
        primaryTextColor: "#e8e8e8",
        primaryBorderColor: "#d77757",
        lineColor: "#8a8a8a",
        clusterBkg: "#1e1e1e",
        clusterBorder: "#3a3a3a",
        titleColor: "#e8e8e8",
        edgeLabelBackground: "#181818",
      },
    });
    await globalThis.mermaid.run({ nodes: [globalThis.document.getElementById("flow")] });
  }, readFileSync(join(here, "flow.mmd"), "utf8"));
  await page.locator("#flow").screenshot({ path: join(docs, "flow.png") });
}

const browser = await chromium.launch();
try {
  await renderGif(browser);
  await renderFlow(browser);
  console.log(`wrote ${join(docs, "overview.gif")} and ${join(docs, "flow.png")}`);
} finally {
  await browser.close();
}
