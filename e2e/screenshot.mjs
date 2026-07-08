// Dev aid: screenshot the join + desk pages mid-recording for design review.
// Requires the preview server and app server to be running (defaults 4173 /
// 8787; in a worktree running the e2e suite, pass its derived port via
// ANTIPHON_E2E_WEB_PORT — see e2e/ports.ts).
import { chromium, devices } from "@playwright/test";

const origin = `http://localhost:${process.env.ANTIPHON_E2E_WEB_PORT ?? 4173}`;
const browser = await chromium.launch({
  args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
});
const sessionId = crypto.randomUUID();

const desk = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
await desk.goto(`${origin}/session/${sessionId}`);

const phones = [];
for (let i = 0; i < 3; i++) {
  const phone = await (
    await browser.newContext({ ...devices["iPhone 15"], baseURL: origin })
  ).newPage();
  await phone.goto(`${origin}/join/${sessionId}`);
  await phone.getByRole("button", { name: /enable microphone/i }).click();
  phones.push(phone);
}
await desk.waitForTimeout(3000);

// Take 1: short, completed.
await desk.getByRole("button", { name: "Record take" }).click();
await desk.waitForTimeout(4000);
await desk.getByRole("button", { name: "Stop take" }).click();
await desk.waitForTimeout(3500);

// Take 2: live while screenshotting.
await desk.getByRole("button", { name: "Record take" }).click();
await desk.waitForTimeout(5000);
await desk.screenshot({ path: "screens/desk-recording.png" });
await phones[0].screenshot({ path: "screens/join-recording.png", fullPage: true });

await desk.getByRole("button", { name: "Stop take" }).click();
await desk.waitForTimeout(5000);
await desk.screenshot({ path: "screens/desk-converged.png" });

await desk.goto(`${origin}/`);
await desk.screenshot({ path: "screens/home.png" });
await browser.close();
process.exit(0);
