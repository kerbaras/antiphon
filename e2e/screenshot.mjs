// Dev aid: screenshot the join + desk pages mid-recording for design review.
// Requires the preview server (4173) and app server (8787) to be running.
import { chromium, devices } from "@playwright/test";

const browser = await chromium.launch({
  args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
});
const sessionId = crypto.randomUUID();

const desk = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
await desk.goto(`http://localhost:4173/session/${sessionId}`);

const phone = await (
  await browser.newContext({ ...devices["iPhone 15"], baseURL: "http://localhost:4173" })
).newPage();
await phone.goto(`http://localhost:4173/join/${sessionId}`);
await phone.getByRole("button", { name: /enable microphone/i }).click();
await desk.waitForTimeout(2500);

await desk.getByRole("button", { name: /record take/i }).click();
await desk.waitForTimeout(3500);
await desk.screenshot({ path: "screens/desk-recording.png" });
await phone.screenshot({ path: "screens/join-recording.png", fullPage: true });

await desk.getByRole("button", { name: /stop take/i }).click();
await desk.waitForTimeout(4000);
await desk.screenshot({ path: "screens/desk-converged.png" });

await desk.goto("http://localhost:4173/");
await desk.screenshot({ path: "screens/home.png" });
await browser.close();
process.exit(0);
