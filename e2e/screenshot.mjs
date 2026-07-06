// Dev aid: screenshot the join page mid-recording for design review.
import { chromium, devices } from "@playwright/test";

const browser = await chromium.launch({
  args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
});
const page = await browser.newPage({
  ...devices["iPhone 15"],
  baseURL: "http://localhost:4173",
});
await page.goto("/join/6f1e7a2c-9d4b-4e8f-b3a1-2c5d8e9f0a1b");
await page.getByRole("button", { name: /enable microphone/i }).click();
await page.getByRole("button", { name: /record/i }).click();
await page.waitForTimeout(1800);
await page.screenshot({ path: "screens/join-recording.png", fullPage: true });
await page.getByRole("button", { name: /stop/i }).click();
await page.waitForTimeout(400);
await page.screenshot({ path: "screens/join-stopped.png", fullPage: true });
await page.goto("/");
await page.screenshot({ path: "screens/home.png" });
await browser.close();
