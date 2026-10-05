// Visit every screen, click the key controls, and fail on any console/page error (dev-only).
import { chromium } from "playwright";
const out = process.argv[2];
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
const errors = [];
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
page.on("console", (m) => { if (m.type() === "error" && !/favicon|Download the React DevTools/.test(m.text())) errors.push(`console: ${m.text().slice(0, 200)}`); });
const results = [];
async function step(name, fn) {
  const before = errors.length;
  try { await fn(); results.push([errors.length === before ? "PASS" : "FAIL", name, errors.slice(before).join(" | ")]); }
  catch (e) { results.push(["FAIL", name, String(e.message).slice(0, 160)]); }
}
async function open(persona) {
  await page.goto("http://localhost:3000");
  await page.evaluate((p) => { localStorage.setItem("queuemind.persona", p); localStorage.setItem("queuemind.intro-seen", "1"); }, persona);
  await page.reload();
  await page.waitForFunction(() => document.body.innerText.length > 400 && !document.querySelector("main .animate-spin:only-child"), null, { timeout: 60000 });
  await page.waitForTimeout(1500);
}
await step("simulation renders + staff '+15 min late'", async () => {
  await open("sim");
  await page.getByRole("button", { name: "Staff" }).click();
  await page.getByRole("button", { name: /\+15 min late/ }).first().click();
  await page.waitForFunction(() => /Every screen updates|No AI used/.test(document.body.innerText), null, { timeout: 30000 });
  await page.screenshot({ path: `${out}/ui-sim.png` });
});
await step("simulation clock: pause and play", async () => {
  await page.getByRole("button", { name: "Pause" }).click();
  await page.waitForFunction(() => /Paused/.test(document.body.innerText), null, { timeout: 10000 });
  await page.getByRole("button", { name: "Play" }).click();
});
await step("patient phone: quick reply goes through Laya", async () => {
  await open("patient");
  await page.getByRole("button", { name: "How long is the wait?" }).click();
  await page.waitForFunction(() => /Laya|agent/.test(document.querySelector("[data-sonner-toaster]")?.textContent ?? ""), null, { timeout: 30000 });
  await page.screenshot({ path: `${out}/ui-patient.png` });
});
await step("front desk: outbox opens", async () => {
  await open("desk");
  await page.getByRole("button", { name: /Outbox/ }).click();
  await page.getByText("Patient messages").waitFor({ timeout: 10000 });
  await page.keyboard.press("Escape");
});
await step("doctor screen renders + delay button", async () => {
  await open("doctor");
  await page.getByRole("button", { name: "+10 min" }).click();
  await page.waitForTimeout(1500);
});
await step("waiting room TV renders", async () => { await open("tv"); await page.getByText("Now serving").first().waitFor(); });
await step("manager: audit filter", async () => { await open("manager"); await page.getByRole("button", { name: "agent", exact: true }).click(); });
await step("how it works: system map journeys", async () => {
  await open("how");
  for (const j of ["Patient SMS", "Staff button", "Clock tick", "Agent event"]) await page.getByRole("button", { name: j }).click();
  await page.screenshot({ path: `${out}/ui-how.png` });
});
await step("live lab renders", async () => { await open("lab"); await page.getByText("The harness, live").waitFor(); });
await browser.close();
for (const [s, n, d] of results) console.log(`${s}  ${n}${d ? `  — ${d}` : ""}`);
const failed = results.filter((r) => r[0] === "FAIL").length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
