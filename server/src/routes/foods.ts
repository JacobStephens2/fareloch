import { Router, Request, Response } from 'express';
import { getDb } from '../db.js';
import { requireAuth, optionalAuth } from '../middleware/auth.js';

const router = Router();

// --- FatSecret OAuth 2.0 token cache ---
let fatSecretToken: string | null = null;
let fatSecretTokenExpiry = 0;

async function getFatSecretToken(): Promise<string | null> {
  const clientId = process.env.FATSECRET_CLIENT_ID;
  const clientSecret = process.env.FATSECRET_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;

  // Reuse cached token if still valid (with 60s buffer)
  if (fatSecretToken && Date.now() < fatSecretTokenExpiry - 60_000) {
    return fatSecretToken;
  }

  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const response = await fetch('https://oauth.fatsecret.com/connect/token', {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials&scope=premier barcode',
    signal: AbortSignal.timeout(5000),
  });

  if (!response.ok) {
    console.error('FatSecret token error:', response.status);
    return null;
  }

  const data = await response.json();
  fatSecretToken = data.access_token;
  fatSecretTokenExpiry = Date.now() + data.expires_in * 1000;
  return fatSecretToken;
}

// Score how closely a food name matches the search query (higher = better match)
function relevanceScore(name: string, query: string): number {
  const n = (name || '').toLowerCase();
  const q = query.toLowerCase();
  if (n === q) return 100;                                    // exact match
  if (n.startsWith(q)) return 80;                             // name starts with query
  const words = n.split(/[\s,\-()]+/);
  if (words.some(w => w === q)) return 70;                    // a word matches exactly
  if (words.some(w => w.startsWith(q))) return 60;            // a word starts with query
  if (n.includes(q)) return 40;                               // query appears somewhere in name
  // Partial: count how many query words appear in the name
  const qWords = q.split(/\s+/);
  const matched = qWords.filter(qw => n.includes(qw)).length;
  if (matched === qWords.length) return 30;                   // all query words found
  return matched / qWords.length * 20;                        // fraction of query words found
}

// Search foods (local DB first, then APIs)
router.get('/search', optionalAuth, async (req: Request, res: Response) => {
  try {
    const query = (req.query.q as string || '').trim();
    if (!query) {
      res.json({ foods: [], external: [] });
      return;
    }

    const db = getDb();
    // Search local foods (user's custom + cached) — only if authenticated
    let local: any[] = [];
    if (req.user) {
      local = db.prepare(`
        SELECT * FROM foods
        WHERE (user_id = ? OR user_id IS NULL)
          AND (name LIKE ? OR brand LIKE ?)
        ORDER BY
          CASE WHEN user_id = ? THEN 0 ELSE 1 END,
          name
        LIMIT 20
      `).all(req.user.userId, `%${query}%`, `%${query}%`, req.user.userId) as any[];
    }

    // Search external APIs
    const [offResults, usdaResults, fsResults] = await Promise.allSettled([
      searchOpenFoodFacts(query),
      searchUSDA(query),
      searchFatSecret(query),
    ]);

    const external: any[] = [];
    if (offResults.status === 'fulfilled') external.push(...offResults.value);
    if (usdaResults.status === 'fulfilled') external.push(...usdaResults.value);
    if (fsResults.status === 'fulfilled') external.push(...fsResults.value);

    // Sort by relevance + unit count bonus, then by source priority as tiebreaker
    const sourcePriority: Record<string, number> = { fatsecret: 0, usda: 1, openfoodfacts: 2 };
    const score = (item: any) => relevanceScore(item.name, query) + Math.min((item.measures?.length || 0) * 2, 10);
    external.sort((a, b) => {
      const rel = score(b) - score(a);
      if (rel !== 0) return rel;
      return (sourcePriority[a.source] ?? 9) - (sourcePriority[b.source] ?? 9);
    });

    res.json({ foods: local, external });
  } catch (e) {
    console.error('Food search error:', e);
    res.status(500).json({ error: 'Search failed' });
  }
});

// Barcode lookup
router.get('/barcode/:code', optionalAuth, async (req: Request, res: Response) => {
  try {
    const code = req.params.code as string;
    const db = getDb();

    // Check this caller's cache first. An unsigned caller only sees an unowned row.
    const cached = db.prepare(
      'SELECT * FROM foods WHERE barcode = ? AND user_id IS ?'
    ).get(code, req.user?.userId ?? null) as any;
    if (cached) {
      res.json({ food: cached });
      return;
    }

    // Try Open Food Facts first
    let food: any = null;

    try {
      const response = await fetch(`https://world.openfoodfacts.org/api/v2/product/${code}.json`,
        { signal: AbortSignal.timeout(5000) });
      if (response.ok) {
        const data = await response.json();
        if (data.status === 1 && data.product) {
          const p = data.product;
          const nutriments = p.nutriments || {};
          food = {
            name: p.product_name || 'Unknown Product',
            brand: p.brands || null,
            barcode: code,
            serving_size: parseFloat(p.serving_quantity) || 100,
            serving_unit: p.serving_quantity_unit || 'g',
            calories: nutriments['energy-kcal_serving'] || nutriments['energy-kcal_100g'] || 0,
            carbs_g: nutriments.carbohydrates_serving || nutriments.carbohydrates_100g || 0,
            protein_g: nutriments.proteins_serving || nutriments.proteins_100g || 0,
            fat_g: nutriments.fat_serving || nutriments.fat_100g || 0,
            fiber_g: nutriments.fiber_serving || nutriments.fiber_100g || 0,
            sugar_g: nutriments.sugars_serving || nutriments.sugars_100g || 0,
            source: 'openfoodfacts',
            source_id: code,
          };
        }
      }
    } catch {
      // Open Food Facts failed, will try FatSecret
    }

    // Fall back to FatSecret barcode lookup
    if (!food) {
      food = await barcodeFatSecret(code);
    }

    if (!food) {
      res.status(404).json({ error: 'Product not found' });
      return;
    }

    // Cache it under the signed-in caller. An unsigned caller leaves the row unowned.
    const result = db.prepare(`
      INSERT INTO foods (user_id, name, brand, barcode, serving_size, serving_unit, calories, carbs_g, protein_g, fat_g, fiber_g, sugar_g, source, source_id, measures)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(req.user?.userId ?? null, food.name, food.brand, food.barcode, food.serving_size, food.serving_unit,
           food.calories, food.carbs_g, food.protein_g, food.fat_g, food.fiber_g, food.sugar_g,
           food.source, food.source_id, food.measures ? JSON.stringify(food.measures) : null);

    res.json({ food: { id: result.lastInsertRowid, ...food } });
  } catch (e) {
    console.error('Barcode lookup error:', e);
    res.status(500).json({ error: 'Barcode lookup failed' });
  }
});

// Get user's custom foods
router.get('/custom', requireAuth, (req: Request, res: Response) => {
  const db = getDb();
  const foods = db.prepare("SELECT * FROM foods WHERE user_id = ? AND source = 'manual' ORDER BY name").all(req.user!.userId);
  res.json({ foods });
});

// Get recent foods (foods the user has logged recently)
router.get('/recent', requireAuth, (req: Request, res: Response) => {
  const db = getDb();
  const foods = db.prepare(`
    SELECT DISTINCT f.* FROM foods f
    JOIN meal_logs m ON (m.food_id = f.id)
    WHERE m.user_id = ?
    ORDER BY m.created_at DESC
    LIMIT 20
  `).all(req.user!.userId);
  res.json({ foods });
});

// Create custom food
router.post('/', requireAuth, (req: Request, res: Response) => {
  try {
    const db = getDb();
    const { name, brand, barcode, servingSize, servingUnit, calories, carbsG, proteinG, fatG, fiberG, sugarG } = req.body;
    if (!name) {
      res.status(400).json({ error: 'Name is required' });
      return;
    }

    const result = db.prepare(`
      INSERT INTO foods (user_id, name, brand, barcode, serving_size, serving_unit, calories, carbs_g, protein_g, fat_g, fiber_g, sugar_g, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual')
    `).run(req.user!.userId, name, brand || null, barcode || null,
           servingSize || 1, servingUnit || 'serving',
           calories || 0, carbsG || 0, proteinG || 0, fatG || 0, fiberG || 0, sugarG || 0);

    const food = db.prepare('SELECT * FROM foods WHERE id = ?').get(result.lastInsertRowid);
    res.json({ food });
  } catch (e) {
    console.error('Create food error:', e);
    res.status(500).json({ error: 'Failed to create food' });
  }
});

// Update custom food
router.put('/:id', requireAuth, (req: Request, res: Response) => {
  try {
    const db = getDb();
    const food = db.prepare('SELECT * FROM foods WHERE id = ? AND user_id = ?').get(req.params.id, req.user!.userId) as any;
    if (!food) {
      res.status(404).json({ error: 'Food not found' });
      return;
    }

    const { name, brand, barcode, servingSize, servingUnit, calories, carbsG, proteinG, fatG, fiberG, sugarG } = req.body;
    db.prepare(`
      UPDATE foods SET
        name = COALESCE(?, name), brand = COALESCE(?, brand), barcode = COALESCE(?, barcode),
        serving_size = COALESCE(?, serving_size), serving_unit = COALESCE(?, serving_unit),
        calories = COALESCE(?, calories), carbs_g = COALESCE(?, carbs_g),
        protein_g = COALESCE(?, protein_g), fat_g = COALESCE(?, fat_g),
        fiber_g = COALESCE(?, fiber_g), sugar_g = COALESCE(?, sugar_g)
      WHERE id = ?
    `).run(name, brand, barcode, servingSize, servingUnit, calories, carbsG, proteinG, fatG, fiberG, sugarG, req.params.id);

    const updated = db.prepare('SELECT * FROM foods WHERE id = ?').get(req.params.id);
    res.json({ food: updated });
  } catch (e) {
    console.error('Update food error:', e);
    res.status(500).json({ error: 'Failed to update food' });
  }
});

// Delete custom food
router.delete('/:id', requireAuth, (req: Request, res: Response) => {
  const db = getDb();
  const result = db.prepare('DELETE FROM foods WHERE id = ? AND user_id = ?').run(req.params.id, req.user!.userId);
  if (result.changes === 0) {
    res.status(404).json({ error: 'Food not found' });
    return;
  }
  res.json({ success: true });
});

// Save an external food result to local DB for logging
router.post('/save-external', requireAuth, (req: Request, res: Response) => {
  try {
    const db = getDb();
    const { name, brand, barcode, servingSize, servingUnit, calories, carbsG, proteinG, fatG, fiberG, sugarG, source, sourceId, measures } = req.body;

    // Check if this caller already saved this source record
    if (sourceId) {
      const existing = db.prepare(
        'SELECT * FROM foods WHERE source = ? AND source_id = ? AND user_id = ?'
      ).get(source, sourceId, req.user!.userId) as any;
      if (existing) {
        res.json({ food: existing });
        return;
      }
    }

    const measuresJson = measures && measures.length > 0 ? JSON.stringify(measures) : null;

    const result = db.prepare(`
      INSERT INTO foods (user_id, name, brand, barcode, serving_size, serving_unit, calories, carbs_g, protein_g, fat_g, fiber_g, sugar_g, source, source_id, measures)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(req.user!.userId, name, brand || null, barcode || null, servingSize || 1, servingUnit || 'serving',
           calories || 0, carbsG || 0, proteinG || 0, fatG || 0, fiberG || 0, sugarG || 0,
           source || 'manual', sourceId || null, measuresJson);

    const food = db.prepare('SELECT * FROM foods WHERE id = ?').get(result.lastInsertRowid);
    res.json({ food });
  } catch (e) {
    console.error('Save external food error:', e);
    res.status(500).json({ error: 'Failed to save food' });
  }
});

// Helper: search Open Food Facts
async function searchOpenFoodFacts(query: string): Promise<any[]> {
  try {
    const url = `https://world.openfoodfacts.org/cgi/search.pl?search_terms=${encodeURIComponent(query)}&search_simple=1&action=process&json=1&page_size=10&fields=product_name,brands,code,nutriments,serving_quantity,serving_quantity_unit`;
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) return [];
    const data = await response.json();
    return (data.products || [])
      .filter((p: any) => p.product_name)
      .map((p: any) => {
        const n = p.nutriments || {};
        return {
          name: p.product_name,
          brand: p.brands || null,
          barcode: p.code || null,
          servingSize: parseFloat(p.serving_quantity) || 100,
          servingUnit: p.serving_quantity_unit || 'g',
          calories: Math.round(n['energy-kcal_serving'] || n['energy-kcal_100g'] || 0),
          carbsG: Math.round((n.carbohydrates_serving || n.carbohydrates_100g || 0) * 10) / 10,
          proteinG: Math.round((n.proteins_serving || n.proteins_100g || 0) * 10) / 10,
          fatG: Math.round((n.fat_serving || n.fat_100g || 0) * 10) / 10,
          fiberG: Math.round((n.fiber_serving || n.fiber_100g || 0) * 10) / 10,
          sugarG: Math.round((n.sugars_serving || n.sugars_100g || 0) * 10) / 10,
          source: 'openfoodfacts',
          sourceId: p.code || null,
        };
      });
  } catch {
    return [];
  }
}

// Helper: search USDA FoodData Central
async function searchUSDA(query: string): Promise<any[]> {
  try {
    const apiKey = process.env.USDA_API_KEY || 'DEMO_KEY';
    const url = `https://api.nal.usda.gov/fdc/v1/foods/search?query=${encodeURIComponent(query)}&pageSize=10&api_key=${apiKey}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) return [];
    const data = await response.json();
    return (data.foods || []).map((f: any) => {
      // Nutrients are per 100g for SR Legacy / Survey, per serving for Branded
      const get = (name: string) => {
        const n = (f.foodNutrients || []).find((n: any) => n.nutrientName === name);
        return n ? Math.round(n.value * 10) / 10 : 0;
      };

      const isBranded = f.dataType === 'Branded';
      const servingSize = f.servingSize || 100;
      const servingUnit = f.servingSizeUnit || 'g';

      // For non-branded, nutrients are per 100g — scale to default serving
      const scale = isBranded ? 1 : servingSize / 100;
      const cal = Math.round(get('Energy') * scale);
      const carbs = Math.round(get('Carbohydrate, by difference') * scale * 10) / 10;
      const protein = Math.round(get('Protein') * scale * 10) / 10;
      const fat = Math.round(get('Total lipid (fat)') * scale * 10) / 10;
      const fiber = Math.round(get('Fiber, total dietary') * scale * 10) / 10;
      const sugar = Math.round((get('Sugars, total including NLEA') || get('Total Sugars')) * scale * 10) / 10;

      // Build measures array from foodMeasures and householdServingFullText
      const measures: { label: string; gramWeight: number }[] = [];

      // Default serving
      if (isBranded && f.householdServingFullText) {
        measures.push({ label: f.householdServingFullText, gramWeight: servingSize });
      }

      // FNDDS / SR Legacy measures
      if (f.foodMeasures && Array.isArray(f.foodMeasures)) {
        for (const m of f.foodMeasures) {
          if (m.disseminationText && m.gramWeight && m.disseminationText !== 'Quantity not specified') {
            measures.push({ label: m.disseminationText, gramWeight: m.gramWeight });
          }
        }
      }

      return {
        name: f.description || 'Unknown',
        brand: f.brandName || f.brandOwner || null,
        barcode: f.gtinUpc || null,
        servingSize,
        servingUnit,
        calories: cal,
        carbsG: carbs,
        proteinG: protein,
        fatG: fat,
        fiberG: fiber,
        sugarG: sugar,
        source: 'usda',
        sourceId: String(f.fdcId),
        measures: measures.length > 0 ? measures : undefined,
      };
    });
  } catch {
    return [];
  }
}

// Helper: get structured food details from FatSecret (premier food.get.v4)
async function getFatSecretFood(token: string, foodId: string): Promise<any | null> {
  try {
    const url = `https://platform.fatsecret.com/rest/server.api?method=food.get.v4&food_id=${foodId}&format=json`;
    const response = await fetch(url, {
      headers: { 'Authorization': `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return null;

    const data = await response.json();
    const food = data.food;
    if (!food) return null;

    const servings = Array.isArray(food.servings?.serving)
      ? food.servings.serving
      : food.servings?.serving ? [food.servings.serving] : [];

    // Use first serving as default
    const defaultServing = servings[0];
    if (!defaultServing) return null;

    const servingSize = parseFloat(defaultServing.metric_serving_amount) || 100;
    const servingUnit = defaultServing.metric_serving_unit || 'g';

    // Build measures array from all servings
    const measures: { label: string; gramWeight: number }[] = [];
    for (const s of servings) {
      const label = s.serving_description;
      const grams = s.metric_serving_unit === 'g'
        ? parseFloat(s.metric_serving_amount)
        : s.metric_serving_unit === 'oz'
          ? parseFloat(s.metric_serving_amount) * 28.3495
          : parseFloat(s.metric_serving_amount);
      if (label && grams) {
        measures.push({ label, gramWeight: Math.round(grams * 10) / 10 });
      }
    }

    return {
      name: food.food_name || 'Unknown',
      brand: food.brand_name || null,
      barcode: null,
      servingSize,
      servingUnit,
      calories: Math.round(parseFloat(defaultServing.calories) || 0),
      carbsG: Math.round((parseFloat(defaultServing.carbohydrate) || 0) * 10) / 10,
      proteinG: Math.round((parseFloat(defaultServing.protein) || 0) * 10) / 10,
      fatG: Math.round((parseFloat(defaultServing.fat) || 0) * 10) / 10,
      fiberG: Math.round((parseFloat(defaultServing.fiber) || 0) * 10) / 10,
      sugarG: Math.round((parseFloat(defaultServing.sugar) || 0) * 10) / 10,
      source: 'fatsecret',
      sourceId: String(food.food_id),
      measures: measures.length > 0 ? measures : undefined,
    };
  } catch {
    return null;
  }
}

// Helper: search FatSecret (premier scope — structured nutrition via food.get.v4)
async function searchFatSecret(query: string): Promise<any[]> {
  try {
    const token = await getFatSecretToken();
    if (!token) return [];

    // Step 1: search for food IDs
    const url = `https://platform.fatsecret.com/rest/server.api?method=foods.search&search_expression=${encodeURIComponent(query)}&max_results=10&format=json`;
    const response = await fetch(url, {
      headers: { 'Authorization': `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return [];

    const data = await response.json();
    const foods = data.foods?.food;
    if (!foods || !Array.isArray(foods)) return [];

    // Step 2: fetch structured details for each food in parallel
    const details = await Promise.allSettled(
      foods.map((f: any) => getFatSecretFood(token, f.food_id))
    );

    return details
      .filter((r): r is PromiseFulfilledResult<any> => r.status === 'fulfilled' && r.value != null)
      .map(r => r.value);
  } catch {
    return [];
  }
}

// Helper: barcode lookup via FatSecret (premier barcode scope)
async function barcodeFatSecret(code: string): Promise<any | null> {
  try {
    const token = await getFatSecretToken();
    if (!token) return null;

    // Step 1: find food_id for barcode
    const findUrl = `https://platform.fatsecret.com/rest/server.api?method=food.find_id_for_barcode&barcode=${encodeURIComponent(code)}&format=json`;
    const findResponse = await fetch(findUrl, {
      headers: { 'Authorization': `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!findResponse.ok) return null;

    const findData = await findResponse.json();
    const foodId = findData.food_id?.value;
    if (!foodId) return null;

    // Step 2: get structured nutrition details
    const f = await getFatSecretFood(token, foodId);
    if (!f) return null;

    // Return snake_case fields to match barcode route's DB insert
    return {
      name: f.name,
      brand: f.brand,
      barcode: code,
      serving_size: f.servingSize,
      serving_unit: f.servingUnit,
      calories: f.calories,
      carbs_g: f.carbsG,
      protein_g: f.proteinG,
      fat_g: f.fatG,
      fiber_g: f.fiberG,
      sugar_g: f.sugarG,
      source: 'fatsecret',
      source_id: f.sourceId,
      measures: f.measures,
    };
  } catch {
    return null;
  }
}

export default router;
