type FoodMeasure = { label: string; gramWeight: number };

export interface ExternalFoodCandidate {
  name: string;
  brand: string | null;
  barcode: string | null;
  servingSize: number;
  servingUnit: string;
  calories: number;
  carbsG: number;
  proteinG: number;
  fatG: number;
  fiberG: number;
  sugarG: number;
  source: 'openfoodfacts' | 'usda' | 'fatsecret';
  sourceId: string | null;
  measures?: FoodMeasure[];
}

export interface ExternalBarcodeCandidate {
  name: string;
  brand: string | null;
  barcode: string;
  serving_size: number;
  serving_unit: string;
  calories: number;
  carbs_g: number;
  protein_g: number;
  fat_g: number;
  fiber_g: number;
  sugar_g: number;
  source: 'openfoodfacts' | 'fatsecret';
  source_id: string | null;
  measures?: FoodMeasure[];
}

// Construct once in production so search and barcode share the token lifetime.
export function createExternalFoodLookup(request: typeof fetch): {
  search(query: string): Promise<ExternalFoodCandidate[]>;
  barcode(code: string): Promise<ExternalBarcodeCandidate | null>;
} {
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
    const response = await request('https://oauth.fatsecret.com/connect/token', {
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

  async function search(query: string): Promise<ExternalFoodCandidate[]> {
    // Search external APIs
    const [offResults, usdaResults, fsResults] = await Promise.allSettled([
      searchOpenFoodFacts(query),
      searchUSDA(query),
      searchFatSecret(query),
    ]);

    const external: ExternalFoodCandidate[] = [];
    if (offResults.status === 'fulfilled') external.push(...offResults.value);
    if (usdaResults.status === 'fulfilled') external.push(...usdaResults.value);
    if (fsResults.status === 'fulfilled') external.push(...fsResults.value);

    // Sort by relevance + unit count bonus, then by source priority as tiebreaker
    const sourcePriority: Record<string, number> = { fatsecret: 0, usda: 1, openfoodfacts: 2 };
    const score = (item: ExternalFoodCandidate) => relevanceScore(item.name, query) + Math.min((item.measures?.length || 0) * 2, 10);
    external.sort((a, b) => {
      const rel = score(b) - score(a);
      if (rel !== 0) return rel;
      return (sourcePriority[a.source] ?? 9) - (sourcePriority[b.source] ?? 9);
    });
    return external;
  }

  async function barcode(code: string): Promise<ExternalBarcodeCandidate | null> {
    // Try Open Food Facts first
    let food: ExternalBarcodeCandidate | null = null;

    try {
      const response = await request(`https://world.openfoodfacts.org/api/v2/product/${code}.json`,
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
    return food;
  }

  // Helper: search Open Food Facts
  async function searchOpenFoodFacts(query: string): Promise<ExternalFoodCandidate[]> {
    try {
      const url = `https://world.openfoodfacts.org/cgi/search.pl?search_terms=${encodeURIComponent(query)}&search_simple=1&action=process&json=1&page_size=10&fields=product_name,brands,code,nutriments,serving_quantity,serving_quantity_unit`;
      const response = await request(url, { signal: AbortSignal.timeout(5000) });
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
  async function searchUSDA(query: string): Promise<ExternalFoodCandidate[]> {
    try {
      const apiKey = process.env.USDA_API_KEY || 'DEMO_KEY';
      const url = `https://api.nal.usda.gov/fdc/v1/foods/search?query=${encodeURIComponent(query)}&pageSize=10&api_key=${apiKey}`;
      const response = await request(url, { signal: AbortSignal.timeout(5000) });
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
  async function getFatSecretFood(token: string, foodId: string): Promise<ExternalFoodCandidate | null> {
    try {
      const url = `https://platform.fatsecret.com/rest/server.api?method=food.get.v4&food_id=${foodId}&format=json`;
      const response = await request(url, {
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
  async function searchFatSecret(query: string): Promise<ExternalFoodCandidate[]> {
    try {
      const token = await getFatSecretToken();
      if (!token) return [];

      // Step 1: search for food IDs
      const url = `https://platform.fatsecret.com/rest/server.api?method=foods.search&search_expression=${encodeURIComponent(query)}&max_results=10&format=json`;
      const response = await request(url, {
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
        .filter((r): r is PromiseFulfilledResult<ExternalFoodCandidate> => r.status === 'fulfilled' && r.value != null)
        .map(r => r.value);
    } catch {
      return [];
    }
  }

  // Helper: barcode lookup via FatSecret (premier barcode scope)
  async function barcodeFatSecret(code: string): Promise<ExternalBarcodeCandidate | null> {
    try {
      const token = await getFatSecretToken();
      if (!token) return null;

      // Step 1: find food_id for barcode
      const findUrl = `https://platform.fatsecret.com/rest/server.api?method=food.find_id_for_barcode&barcode=${encodeURIComponent(code)}&format=json`;
      const findResponse = await request(findUrl, {
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

  return { search, barcode };
}
