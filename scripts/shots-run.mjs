// Let the simulation run on autopilot and capture it (dev-only helper).
import { chromium } from "playwright";
const out = process.argv[2];
const wait = Number(process.argv[3] ?? 40000);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
await page.goto("http://localhost:3000");
await page.evaluate(() => { localStorage.setItem("queuemind.persona", "sim"); localStorage.setItem("queuemind.intro-seen", "1"); });
await page.reload();
await page.waitForTimeout(wait);
await page.screenshot({ path: `${out}/sim-autopilot.png` });
await browser.close();
console.log("ok");
