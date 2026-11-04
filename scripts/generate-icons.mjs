// Render the shared SVG brand mark to the PNG sizes used by browser manifests.
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const source = new URL('../public/icon.svg', import.meta.url);
const output = new URL('../public/icon/', import.meta.url);
const svg = await fs.readFile(source, 'utf8');
await fs.mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: 'chromium', headless: true });
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  await page.setContent(`<style>html,body{margin:0;width:100%;height:100%;overflow:hidden}svg{display:block;width:100%;height:100%}</style>${svg}`);
  for (const size of [16, 32, 48, 96, 128]) {
    await page.setViewportSize({ width: size, height: size });
    await page.screenshot({ path: fileURLToPath(new URL(`${size}.png`, output)), omitBackground: true });
    console.log(`Generated icon/${size}.png`);
  }
} finally {
  await browser.close();
}
