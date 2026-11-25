// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createExternalFoodLookup } from './external-food-lookup.js';

beforeEach(() => {
  vi.stubEnv('FATSECRET_CLIENT_ID', '');
  vi.stubEnv('FATSECRET_CLIENT_SECRET', '');
  vi.stubEnv('USDA_API_KEY', '');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function transport(reply: (url: URL, init?: RequestInit) => Response | Promise<Response>) {
  return vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    return reply(url, init);
  });
}

it('maps Open Food Facts search nutrition with truthy fallbacks and search rounding', async () => {
  vi.stubEnv('FATSECRET_CLIENT_ID', '');
  vi.stubEnv('FATSECRET_CLIENT_SECRET', '');
  const request = transport(url => {
    if (url.hostname === 'api.nal.usda.gov') return json({ foods: [] });
    expect(url.searchParams.get('search_terms')).toBe('Oats & milk');
    return json({ products: [{
      product_name: 'Oats & milk', brands: 'Farm', code: '0012',
      serving_quantity: '40.5', serving_quantity_unit: 'ml',
      nutriments: {
        'energy-kcal_serving': 0, 'energy-kcal_100g': 123.56,
        carbohydrates_serving: 12.34, carbohydrates_100g: 99,
        proteins_serving: 0, proteins_100g: 4.56,
        fat_serving: 1.26, fiber_serving: 2.34, sugars_100g: 3.45,
      },
    }, { product_name: '' }] });
  });

  const lookup = createExternalFoodLookup(request);
  expect(await lookup.search('Oats & milk')).toEqual([{
    name: 'Oats & milk', brand: 'Farm', barcode: '0012',
    servingSize: 40.5, servingUnit: 'ml', calories: 124,
    carbsG: 12.3, proteinG: 4.6, fatG: 1.3, fiberG: 2.3, sugarG: 3.5,
    source: 'openfoodfacts', sourceId: '0012',
  }]);
  expect(request).toHaveBeenCalledTimes(2);
});

it('keeps Open Food Facts search defaults and omits measures and saved identity', async () => {
  const lookup = createExternalFoodLookup(transport(url => url.hostname === 'api.nal.usda.gov'
    ? json({}) : json({ products: [{ product_name: 'Beans', serving_quantity: '0' }] })));
  expect(await lookup.search('Beans')).toEqual([{
    name: 'Beans', brand: null, barcode: null, servingSize: 100, servingUnit: 'g',
    calories: 0, carbsG: 0, proteinG: 0, fatG: 0, fiberG: 0, sugarG: 0,
    source: 'openfoodfacts', sourceId: null,
  }]);
});

it('maps USDA branded and scaled survey nutrition with household measures', async () => {
  const nutrients = [
    { nutrientName: 'Energy', value: 123.46 },
    { nutrientName: 'Carbohydrate, by difference', value: 12.34 },
    { nutrientName: 'Protein', value: 4.56 },
    { nutrientName: 'Total lipid (fat)', value: 2.34 },
    { nutrientName: 'Fiber, total dietary', value: 1.26 },
    { nutrientName: 'Sugars, total including NLEA', value: 0 },
    { nutrientName: 'Total Sugars', value: 3.45 },
  ];
  const request = transport(url => {
    if (url.hostname !== 'api.nal.usda.gov') return json({});
    expect(url.searchParams.get('api_key')).toBe('DEMO_KEY');
    expect(url.searchParams.get('query')).toBe('Oats & milk');
    expect(url.searchParams.get('pageSize')).toBe('10');
    return json({ foods: [
      {
        description: 'Branded oats', dataType: 'Branded', fdcId: 101,
        brandName: 'Farm', brandOwner: 'Owner', gtinUpc: '0123',
        servingSize: 40, servingSizeUnit: 'ml', foodNutrients: nutrients,
        householdServingFullText: '1/2 cup', foodMeasures: [
          { disseminationText: '1 tbsp', gramWeight: 10.25 },
          { disseminationText: 'Quantity not specified', gramWeight: 100 },
          { disseminationText: 'empty', gramWeight: 0 }, { gramWeight: 10 },
        ],
      },
      {
        description: 'Survey oats', dataType: 'Survey (FNDDS)', fdcId: 102,
        brandName: '', brandOwner: 'Owner', servingSize: 40,
        foodNutrients: nutrients, householdServingFullText: 'ignored for survey',
        foodMeasures: [{ disseminationText: '1 cup', gramWeight: 80 }],
      },
    ] });
  });
  expect(await createExternalFoodLookup(request).search('Oats & milk')).toEqual([
    {
      name: 'Branded oats', brand: 'Farm', barcode: '0123', servingSize: 40, servingUnit: 'ml',
      calories: 124, carbsG: 12.3, proteinG: 4.6, fatG: 2.3, fiberG: 1.3, sugarG: 3.5,
      source: 'usda', sourceId: '101', measures: [
        { label: '1/2 cup', gramWeight: 40 }, { label: '1 tbsp', gramWeight: 10.25 },
      ],
    },
    {
      name: 'Survey oats', brand: 'Owner', barcode: null, servingSize: 40, servingUnit: 'g',
      calories: 49, carbsG: 4.9, proteinG: 1.8, fatG: 0.9, fiberG: 0.5, sugarG: 1.4,
      source: 'usda', sourceId: '102', measures: [{ label: '1 cup', gramWeight: 80 }],
    },
  ]);
});

it('reads USDA keys per search and keeps missing USDA field defaults', async () => {
  const keys: (string | null)[] = [];
  const lookup = createExternalFoodLookup(transport(url => {
    if (url.hostname !== 'api.nal.usda.gov') return json({});
    keys.push(url.searchParams.get('api_key'));
    return json({ foods: [{ fdcId: 7, servingSize: 0, servingSizeUnit: '' }] });
  }));
  const expected = [{
    name: 'Unknown', brand: null, barcode: null, servingSize: 100, servingUnit: 'g',
    calories: 0, carbsG: 0, proteinG: 0, fatG: 0, fiberG: 0, sugarG: 0,
    source: 'usda', sourceId: '7', measures: undefined,
  }];
  expect(await lookup.search('food')).toEqual(expected);
  vi.stubEnv('USDA_API_KEY', 'new-key');
  expect(await lookup.search('food')).toEqual(expected);
  expect(keys).toEqual(['DEMO_KEY', 'new-key']);
});

function enableFatSecret() {
  vi.stubEnv('FATSECRET_CLIENT_ID', 'client');
  vi.stubEnv('FATSECRET_CLIENT_SECRET', 'secret');
}

function serving(overrides: Record<string, unknown> = {}) {
  return {
    metric_serving_amount: '2', metric_serving_unit: 'oz', serving_description: '2 oz',
    calories: '123.56', carbohydrate: '12.34', protein: '4.56', fat: '2.34',
    fiber: '1.26', sugar: '3.45', ...overrides,
  };
}

function fatSecretFood(servings: unknown = serving(), overrides: Record<string, unknown> = {}) {
  return { food: {
    food_id: '42', food_name: 'Oats', brand_name: 'Farm',
    servings: { serving: servings }, ...overrides,
  } };
}

// These are upstream request names, not mocks of lookup helpers.
function endpoint(url: URL): string {
  if (url.hostname === 'oauth.fatsecret.com') return 'token';
  if (url.hostname === 'platform.fatsecret.com') return url.searchParams.get('method')!;
  if (url.hostname === 'api.nal.usda.gov') return 'usda';
  return url.pathname === '/cgi/search.pl' ? 'off-search' : 'off-barcode';
}

function successfulReply(url: URL): Response {
  switch (endpoint(url)) {
    case 'token': return json({ access_token: 'token', expires_in: 3600 });
    case 'foods.search': return json({ foods: { food: [{ food_id: '42' }] } });
    case 'food.find_id_for_barcode': return json({ food_id: { value: '42' } });
    case 'food.get.v4': return json(fatSecretFood());
    case 'off-search': return json({ products: [{ product_name: 'Oats', code: 'off' }] });
    case 'off-barcode': return json({ status: 0 });
    case 'usda': return json({ foods: [{ description: 'Oats', fdcId: 'usda' }] });
    default: throw new Error(`Unexpected upstream request: ${url}`);
  }
}

it.each(['singleton', 'array'])('maps FatSecret %s servings and gram, ounce and other measures', async shape => {
  enableFatSecret();
  const first = serving();
  const detail = shape === 'singleton' ? first : [first,
    serving({ metric_serving_amount: '40.25', metric_serving_unit: 'g', serving_description: '1 cup' }),
    serving({ metric_serving_amount: '15.25', metric_serving_unit: 'ml', serving_description: '1 tbsp' }),
    serving({ metric_serving_amount: '0', serving_description: 'zero' }),
    serving({ serving_description: '' }),
  ];
  const request = transport(url => {
    if (['off-search', 'usda'].includes(endpoint(url))) return json({});
    if (endpoint(url) === 'food.get.v4') return json(fatSecretFood(detail));
    return successfulReply(url);
  });
  expect(await createExternalFoodLookup(request).search('Oats')).toEqual([{
    name: 'Oats', brand: 'Farm', barcode: null, servingSize: 2, servingUnit: 'oz',
    calories: 124, carbsG: 12.3, proteinG: 4.6, fatG: 2.3, fiberG: 1.3, sugarG: 3.5,
    source: 'fatsecret', sourceId: '42', measures: shape === 'singleton'
      ? [{ label: '2 oz', gramWeight: 56.7 }]
      : [{ label: '2 oz', gramWeight: 56.7 }, { label: '1 cup', gramWeight: 40.3 },
        { label: '1 tbsp', gramWeight: 15.3 }],
  }]);
});

it('keeps FatSecret missing field defaults and omits empty measures', async () => {
  enableFatSecret();
  const lookup = createExternalFoodLookup(transport(url => {
    if (['off-search', 'usda'].includes(endpoint(url))) return json({});
    if (endpoint(url) === 'food.get.v4') return json(fatSecretFood({}, {
      food_name: '', brand_name: '', food_id: 42,
    }));
    return successfulReply(url);
  }));
  expect(await lookup.search('food')).toEqual([{
    name: 'Unknown', brand: null, barcode: null, servingSize: 100, servingUnit: 'g',
    calories: 0, carbsG: 0, proteinG: 0, fatG: 0, fiberG: 0, sugarG: 0,
    source: 'fatsecret', sourceId: '42', measures: undefined,
  }]);
});

it('preserves every relevance branch and stable order within a source', async () => {
  const names = ['Unrelated', 'Wild oatmeal', 'myoat', 'Wild oat', 'Oat flakes', 'oAt', 'OAT'];
  const lookup = createExternalFoodLookup(transport(url => endpoint(url) === 'off-search'
    ? json({ products: names.map(product_name => ({ product_name })) }) : json({})));
  expect((await lookup.search('oat')).map(food => food.name)).toEqual([
    'oAt', 'OAT', 'Oat flakes', 'Wild oat', 'Wild oatmeal', 'myoat', 'Unrelated',
  ]);
  const multi = createExternalFoodLookup(transport(url => endpoint(url) === 'off-search'
    ? json({ products: ['Plain', 'Red fruit', 'Red green fruit'].map(product_name => ({ product_name })) })
    : json({})));
  expect((await multi.search('red green')).map(food => food.name)).toEqual([
    'Red green fruit', 'Red fruit', 'Plain',
  ]);
  const reordered = createExternalFoodLookup(transport(url => endpoint(url) === 'off-search'
    ? json({ products: ['Red fruit', 'Green red', 'Plain'].map(product_name => ({ product_name })) })
    : json({})));
  expect((await reordered.search('red green')).map(food => food.name)).toEqual([
    'Green red', 'Red fruit', 'Plain',
  ]);
});

it('caps the two-per-measure bonus at ten and keeps source tie priority', async () => {
  enableFatSecret();
  const lookup = createExternalFoodLookup(transport(url => {
    if (endpoint(url) === 'usda') return json({ foods: [
      { description: 'Oat flakes', fdcId: 'many', foodMeasures: Array.from({ length: 20 },
        (_, i) => ({ disseminationText: `measure ${i}`, gramWeight: 10 })) },
      { description: 'Wild oat', fdcId: 'five', foodMeasures: Array.from({ length: 5 },
        (_, i) => ({ disseminationText: `measure ${i}`, gramWeight: 10 })) },
      { description: 'Oat', fdcId: 'two', foodMeasures: [
        { disseminationText: 'cup', gramWeight: 10 }, { disseminationText: 'spoon', gramWeight: 5 },
      ] },
      { description: 'Oat', fdcId: 'usda' },
    ] });
    if (endpoint(url) === 'food.get.v4') return json(fatSecretFood(serving({ serving_description: '' }), { food_name: 'Oat' }));
    if (endpoint(url) === 'off-search') return json({ products: [{ product_name: 'Oat', code: 'off' }] });
    return successfulReply(url);
  }));
  expect((await lookup.search('oat')).map(food => food.sourceId)).toEqual([
    'two', '42', 'usda', 'off', 'many', 'five',
  ]);
});

it('keeps exact measure-bonus boundaries when all three sources tie', async () => {
  enableFatSecret();
  const lookup = createExternalFoodLookup(transport(url => {
    if (endpoint(url) === 'off-search') return json({ products: [
      { product_name: 'red', code: 'off-two' },
      { product_name: 'red green blue white black', code: 'off-ten' },
    ] });
    if (endpoint(url) === 'usda') return json({ foods: [
      { description: 'unrelated', fdcId: 'usda-two', foodMeasures: [{ disseminationText: 'cup', gramWeight: 10 }] },
      { description: 'unrelated', fdcId: 'usda-ten', foodMeasures: Array.from({ length: 20 },
        (_, i) => ({ disseminationText: `measure ${i}`, gramWeight: 10 })) },
    ] });
    if (endpoint(url) === 'foods.search') return json({ foods: { food: [
      { food_id: 'fs-two' }, { food_id: 'fs-ten' },
    ] } });
    if (endpoint(url) === 'food.get.v4') return json(fatSecretFood({}, {
      food_id: url.searchParams.get('food_id'),
      food_name: url.searchParams.get('food_id') === 'fs-two' ? 'red' : 'red green blue white black',
    }));
    return successfulReply(url);
  }));
  expect((await lookup.search('red green blue white black amber violet indigo teal orange'))
    .map(food => food.sourceId)).toEqual([
    'fs-ten', 'usda-ten', 'off-ten', 'fs-two', 'usda-two', 'off-two',
  ]);
});

it('starts every provider concurrently and keeps source order despite completion order', async () => {
  enableFatSecret();
  let releaseOff!: (response: Response) => void;
  let releaseUsda!: (response: Response) => void;
  let releaseToken!: (response: Response) => void;
  const started: string[] = [];
  const lookup = createExternalFoodLookup(transport(url => {
    const name = endpoint(url);
    started.push(name);
    if (name === 'off-search') return new Promise<Response>(resolve => { releaseOff = resolve; });
    if (name === 'usda') return new Promise<Response>(resolve => { releaseUsda = resolve; });
    if (name === 'token') return new Promise<Response>(resolve => { releaseToken = resolve; });
    return successfulReply(url);
  }));
  const pending = lookup.search('Oats');
  expect(started).toEqual(['off-search', 'usda', 'token']);
  releaseToken(json({ access_token: 'token', expires_in: 3600 }));
  releaseUsda(json({ foods: [{ description: 'Oats', fdcId: 'u1' }, { description: 'Oats', fdcId: 'u2' }] }));
  releaseOff(json({ products: [{ product_name: 'Oats', code: 'o1' }, { product_name: 'Oats', code: 'o2' }] }));
  expect((await pending).map(food => food.sourceId)).toEqual(['42', 'u1', 'u2', 'o1', 'o2']);
});

it('returns Open Food Facts barcode precision without search-only fields', async () => {
  enableFatSecret();
  const request = transport(url => {
    expect(url.pathname).toBe('/api/v2/product/000123.json');
    return json({ status: 1, product: {
      product_name: 'Oats', brands: 'Farm', serving_quantity: '40.5', serving_quantity_unit: 'ml',
      nutriments: {
        'energy-kcal_serving': 0, 'energy-kcal_100g': 123.56,
        carbohydrates_serving: 12.34, proteins_100g: 4.56,
        fat_serving: 2.34, fiber_serving: 1.26, sugars_serving: 3.45,
      },
    } });
  });
  expect(await createExternalFoodLookup(request).barcode('000123')).toEqual({
    name: 'Oats', brand: 'Farm', barcode: '000123', serving_size: 40.5, serving_unit: 'ml',
    calories: 123.56, carbs_g: 12.34, protein_g: 4.56, fat_g: 2.34, fiber_g: 1.26, sugar_g: 3.45,
    source: 'openfoodfacts', source_id: '000123',
  });
  expect(request).toHaveBeenCalledTimes(1);
});

it('treats a status-one Open Food Facts product without nutrition as found', async () => {
  enableFatSecret();
  const request = transport(() => json({ status: 1, product: { serving_quantity: '0' } }));
  expect(await createExternalFoodLookup(request).barcode('123')).toEqual({
    name: 'Unknown Product', brand: null, barcode: '123', serving_size: 100, serving_unit: 'g',
    calories: 0, carbs_g: 0, protein_g: 0, fat_g: 0, fiber_g: 0, sugar_g: 0,
    source: 'openfoodfacts', source_id: '123',
  });
  expect(request).toHaveBeenCalledTimes(1);
});

it('falls back to FatSecret with the unchanged barcode and array measures', async () => {
  enableFatSecret();
  const requests: string[] = [];
  const lookup = createExternalFoodLookup(transport(url => {
    requests.push(endpoint(url));
    if (endpoint(url) === 'food.find_id_for_barcode') {
      expect(url.searchParams.get('barcode')).toBe('00+123');
    }
    return successfulReply(url);
  }));
  expect(await lookup.barcode('00+123')).toEqual({
    name: 'Oats', brand: 'Farm', barcode: '00+123', serving_size: 2, serving_unit: 'oz',
    calories: 124, carbs_g: 12.3, protein_g: 4.6, fat_g: 2.3, fiber_g: 1.3, sugar_g: 3.5,
    source: 'fatsecret', source_id: '42', measures: [{ label: '2 oz', gramWeight: 56.7 }],
  });
  expect(requests).toEqual(['off-barcode', 'token', 'food.find_id_for_barcode', 'food.get.v4']);
});

const failures = [
  { name: 'rejected request', response: (): Response => { throw new Error('offline'); } },
  { name: 'non-OK response', response: () => json({}, 503) },
  { name: 'invalid JSON', response: () => new Response('{broken') },
];

for (const failed of ['off-search', 'usda', 'token', 'foods.search', 'food.get.v4']) {
  it.each(failures)(`isolates ${failed} $name from successful search results`, async failure => {
    enableFatSecret();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const reached: string[] = [];
    const lookup = createExternalFoodLookup(transport(url => {
      reached.push(endpoint(url));
      if (endpoint(url) === failed) return failure.response();
      return successfulReply(url);
    }));
    const results = await lookup.search('Oats');
    expect(results.map(food => food.source)).toEqual(failed === 'off-search'
      ? ['fatsecret', 'usda'] : failed === 'usda' ? ['fatsecret', 'openfoodfacts']
        : ['usda', 'openfoodfacts']);
    expect(reached).toContain(failed);
  });
}

for (const failed of ['off-barcode', 'token', 'food.find_id_for_barcode', 'food.get.v4']) {
  it.each(failures)(`preserves barcode fallback/not-found on ${failed} $name`, async failure => {
    enableFatSecret();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const reached: string[] = [];
    const lookup = createExternalFoodLookup(transport(url => {
      reached.push(endpoint(url));
      if (endpoint(url) === failed) return failure.response();
      return successfulReply(url);
    }));
    const result = await lookup.barcode('123');
    if (failed === 'off-barcode') expect(result?.source).toBe('fatsecret');
    else expect(result).toBeNull();
    expect(reached).toContain(failed);
  });
}

it('retains good FatSecret details when another detail fails or has missing servings', async () => {
  enableFatSecret();
  const lookup = createExternalFoodLookup(transport(url => {
    if (['off-search', 'usda'].includes(endpoint(url))) return json({});
    if (endpoint(url) === 'foods.search') return json({ foods: { food: [
      { food_id: '42' }, { food_id: 'broken' }, { food_id: 'empty' },
    ] } });
    if (url.searchParams.get('food_id') === 'broken') throw new Error('detail failed');
    if (url.searchParams.get('food_id') === 'empty') return json({ food: { food_name: 'Empty' } });
    return successfulReply(url);
  }));
  expect((await lookup.search('Oats')).map(food => food.sourceId)).toEqual(['42']);
});

it.each([
  { provider: 'off-search', body: { products: {} } },
  { provider: 'off-search', body: { products: [null] } },
  { provider: 'usda', body: { foods: {} } },
  { provider: 'usda', body: { foods: [{ foodNutrients: {} }] } },
  { provider: 'foods.search', body: {} },
  { provider: 'foods.search', body: { foods: { food: { food_id: '42' } } } },
  { provider: 'food.get.v4', body: {} },
  { provider: 'food.get.v4', body: { food: { servings: { serving: [] } } } },
])('keeps search partial results on missing or untraversable $provider data: $body', async ({ provider, body }) => {
  enableFatSecret();
  const lookup = createExternalFoodLookup(transport(url => endpoint(url) === provider
    ? json(body) : successfulReply(url)));
  expect((await lookup.search('Oats')).map(food => food.source)).toEqual(provider === 'off-search'
    ? ['fatsecret', 'usda'] : provider === 'usda' ? ['fatsecret', 'openfoodfacts']
      : ['usda', 'openfoodfacts']);
});

it.each([
  { provider: 'off-barcode', body: { status: 1 }, source: 'fatsecret' },
  { provider: 'off-barcode', body: {}, source: 'fatsecret' },
  { provider: 'food.find_id_for_barcode', body: {}, source: null },
  { provider: 'food.find_id_for_barcode', body: { food_id: {} }, source: null },
  { provider: 'food.get.v4', body: {}, source: null },
  { provider: 'food.get.v4', body: { food: { servings: {} } }, source: null },
])('preserves barcode missing-data behavior for $provider: $body', async ({ provider, body, source }) => {
  enableFatSecret();
  const lookup = createExternalFoodLookup(transport(url => endpoint(url) === provider
    ? json(body) : successfulReply(url)));
  expect((await lookup.barcode('123'))?.source ?? null).toBe(source);
});

it.each(['FATSECRET_CLIENT_ID', 'FATSECRET_CLIENT_SECRET'])('checks missing %s even with a cached token', async missing => {
  enableFatSecret();
  const calls: string[] = [];
  const lookup = createExternalFoodLookup(transport(url => {
    calls.push(endpoint(url));
    return successfulReply(url);
  }));
  expect((await lookup.search('Oats')).some(food => food.source === 'fatsecret')).toBe(true);
  calls.length = 0;
  vi.stubEnv(missing, '');
  expect(await lookup.barcode('123')).toBeNull();
  expect((await lookup.search('Oats')).map(food => food.source)).toEqual(['usda', 'openfoodfacts']);
  expect(calls).toEqual(['off-barcode', 'off-search', 'usda']);
});

it('reuses tokens across search and barcode and renews exactly at the expiry buffer', async () => {
  enableFatSecret();
  const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
  const timeout = vi.spyOn(AbortSignal, 'timeout');
  const tokens: string[] = [];
  const bearer: string[] = [];
  const lookup = createExternalFoodLookup(transport((url, init) => {
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    if (endpoint(url) === 'token') {
      expect(init).toMatchObject({
        method: 'POST',
        headers: { Authorization: 'Basic Y2xpZW50OnNlY3JldA==', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'grant_type=client_credentials&scope=premier barcode',
      });
      const token = `token-${tokens.length + 1}`;
      tokens.push(token);
      return json({ access_token: token, expires_in: 120 });
    }
    if (url.hostname === 'platform.fatsecret.com') bearer.push(new Headers(init?.headers).get('Authorization')!);
    return successfulReply(url);
  }));
  expect((await lookup.search('Oats')).some(food => food.source === 'fatsecret')).toBe(true);
  now.mockReturnValue(1_059_999);
  expect((await lookup.barcode('123'))?.source).toBe('fatsecret');
  expect(tokens).toEqual(['token-1']);
  now.mockReturnValue(1_060_000);
  expect((await lookup.barcode('456'))?.source).toBe('fatsecret');
  expect(tokens).toEqual(['token-1', 'token-2']);
  expect(bearer).toEqual(['Bearer token-1', 'Bearer token-1', 'Bearer token-1',
    'Bearer token-1', 'Bearer token-2', 'Bearer token-2']);
  expect(timeout.mock.calls).toEqual(Array.from({ length: 12 }, () => [5000]));
});

it('keeps tokens private to each newly constructed lookup', async () => {
  enableFatSecret();
  const request = transport(successfulReply);
  await createExternalFoodLookup(request).barcode('123');
  await createExternalFoodLookup(request).barcode('123');
  expect(request.mock.calls.filter(([input]) => new URL(String(input)).hostname === 'oauth.fatsecret.com')).toHaveLength(2);
});
