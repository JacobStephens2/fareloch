import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';

// Use the same Chrome override as test-android-upgrade.mjs.
const server = await createServer({ server: { host: '127.0.0.1', port: 0 } });
let browser;
try {
  await server.listen();
  browser = await chromium.launch({
    ...(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : { channel: 'chrome' }),
    headless: true,
  });

  for (const [width, height] of [[1440, 900], [390, 844], [320, 844]]) {
    const page = await browser.newPage({ viewport: { width, height }, colorScheme: width < 400 ? 'dark' : 'light' });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('https://analytics.stephens.page/**', route => route.abort());
    await page.addInitScript(() => {
      localStorage.setItem('guest_mode', 'true');
      localStorage.setItem('guest_user', JSON.stringify({
        targetCalories: 2000, targetCarbsG: 250, targetProteinG: 150, targetFatG: 60,
        workoutTargetCalories: 2400, workoutTargetCarbsG: 290, workoutTargetProteinG: 170, workoutTargetFatG: 80,
      }));
      const now = new Date();
      const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      const meals = ['breakfast', 'lunch', 'dinner', 'snack'].flatMap((type, i) =>
        Array.from({ length: 4 }, (_, j) => ({
          id: i * 4 + j + 1, user_id: 0, date, meal_type: type, food_id: null, recipe_id: null,
          servings: 1, calories: 100, carbs_g: 10, protein_g: 5, fat_g: 3,
          note: `${type} food ${j + 1}`, food_name: null, food_brand: null,
          serving_size: 1, serving_unit: 'serving', unit_label: null, unit_scale: 1,
          created_at: null, recipe_name: null,
        })),
      );
      localStorage.setItem('guest_meals', JSON.stringify(meals));
    });

    await page.goto(server.resolvedUrls.local[0]);
    await page.locator('.meal-item').last().waitFor();
    const summary = page.getByRole('region', { name: 'Day totals' });
    assert(!await summary.isVisible(), `${width}px: keep the compact summary hidden at the top`);

    async function scrollToDinner() {
      await page.evaluate(async () => {
        await document.fonts.ready;
        const section = document.querySelectorAll('.meal-section')[2];
        window.scrollTo(0, section.getBoundingClientRect().top + window.scrollY - 160);
      });
      // Let the browser deliver scroll events and paint the pinned bar.
      await page.waitForTimeout(100);
    }

    async function checkTotals(values) {
      for (const value of values) {
        await summary.getByText(value, { exact: true }).waitFor({ state: 'visible', timeout: 5000 });
      }
    }

    await scrollToDinner();
    assert(await summary.isVisible(), `${width}px: day totals must stay visible while viewing dinner`);
    await checkTotals(['1600 / 2000', '160 / 250', '80 / 150', '48 / 60']);
    const box = await summary.boundingBox();
    assert(box.y >= 0 && box.y + box.height < 160, `${width}px: summary must sit at the top above dinner`);
    assert(box.x >= 0 && box.x + box.width <= width, `${width}px: summary must fit the viewport`);
    await page.evaluate(() => window.scrollBy(0, 100));
    assert.equal((await summary.boundingBox()).y, box.y, `${width}px: summary must remain pinned as meals scroll`);
    console.log(`PASS ${width}x${height}: whole-day totals stay above dinner`);

    await page.evaluate(() => window.scrollTo(0, 0));
    await summary.waitFor({ state: 'hidden' });
    await page.getByLabel('Workout day', { exact: true }).check();
    await scrollToDinner();
    await checkTotals(['1600 / 2400', '160 / 290', '80 / 170', '48 / 80']);

    await page.getByText('dinner food 1', { exact: true }).click();
    await page.getByLabel('Calories', { exact: true }).fill('1000');
    await page.getByLabel('Carbs (g)', { exact: true }).fill('210');
    await page.getByLabel('Protein (g)', { exact: true }).fill('105');
    await page.getByLabel('Fat (g)', { exact: true }).fill('43');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await checkTotals(['2500 / 2400', '360 / 290', '180 / 170', '88 / 80']);

    await page.getByRole('button', { name: 'Previous day', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#cal-value')?.textContent === '0');
    // Read the rendered region even while it is hidden at the top of a short day.
    const datedSummary = page.getByRole('region', { name: 'Day totals', includeHidden: true });
    for (const value of ['0 / 2000', '0 / 250', '0 / 150', '0 / 60']) {
      assert.equal(await datedSummary.getByText(value, { exact: true }).count(), 1);
    }
    assert(await datedSummary.getByText('Yesterday', { exact: true }).count() === 1);
    await page.getByRole('button', { name: 'Next day', exact: true }).click();
    await scrollToDinner();
    await checkTotals(['2500 / 2400', '360 / 290', '180 / 170', '88 / 80']);

    await page.locator('a[href="#/settings"]').click();
    await summary.waitFor({ state: 'detached', timeout: 5000 });
    await page.evaluate(() => {
      window.scrollTo(0, 100);
      window.dispatchEvent(new Event('resize'));
    });
    await page.locator('a[href="#/"]').click();
    await page.locator('.meal-item').last().waitFor();
    await scrollToDinner();
    await checkTotals(['2500 / 2400', '360 / 290', '180 / 170', '88 / 80']);

    await page.evaluate(() => {
      document.documentElement.style.setProperty('--safe-area-inset-top', '24px');
      document.documentElement.style.setProperty('--safe-area-inset-left', '8px');
      document.documentElement.style.setProperty('--safe-area-inset-right', '8px');
      window.dispatchEvent(new Event('resize'));
    });
    const textTop = await summary.getByText('Day totals', { exact: true }).boundingBox();
    assert(textTop.y >= 24, `${width}px: summary text must clear the system status bar`);
    for (const value of ['2500 / 2400', '360 / 290', '180 / 170', '88 / 80']) {
      const valueBox = await summary.getByText(value, { exact: true }).boundingBox();
      assert(valueBox.x >= 8 && valueBox.x + valueBox.width <= width - 8, `${width}px: total must clear side insets`);
    }
    assert.deepEqual(errors, [], `${width}px: dashboard navigation must not leave throwing scroll handlers`);
    console.log(`PASS ${width}x${height}: targets, edits, dates, disposal, and safe areas`);
    await page.close();
  }
} finally {
  await browser?.close();
  await server.close();
}
