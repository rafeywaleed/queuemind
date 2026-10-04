// Capture each persona view (dev-only helper).
import { chromium } from "playwright";
const out = process.argv[2];
const personas = (process.argv[3] ?? "desk,doctor,patient,tv,manager").split(",");
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
for (const p of personas) {
  await page.goto("http://localhost:3000");
  await page.evaluate((p) => { localStorage.setItem("queuemind.persona", p); localStorage.setItem("queuemind.intro-seen", "1"); }, p);
  await page.reload();
  await page.waitForFunction(() => !document.querySelector(".animate-spin") || document.body.innerText.includes("Room"), null, { timeout: 90000 }).catch(() => {});
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${out}/${p}.png`, fullPage: true });
}
await browser.close();
console.log(errors.length ? errors.slice(0, 8).join("\n") : "no console errors");
