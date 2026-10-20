type RouteHandler = (params: Record<string, string>) => { html: string; init: () => void };

const routes: { pattern: RegExp; handler: RouteHandler }[] = [];
let currentCleanup: (() => void) | null = null;

export function route(pattern: string, handler: RouteHandler) {
  // Convert route pattern to regex: /recipes/:id -> /recipes/([^/]+)
  const regexStr = '^' + pattern.replace(/:([^/]+)/g, '([^/]+)') + '$';
  const paramNames = [...pattern.matchAll(/:([^/]+)/g)].map((m) => m[1]);
  const regex = new RegExp(regexStr);

  routes.push({
    pattern: regex,
    handler: (rawParams) => {
      // Merge named params
      const match = rawParams._match;
      const params: Record<string, string> = {};
      if (match) {
        paramNames.forEach((name, i) => {
          params[name] = match[i + 1] || '';
        });
      }
      // Include query params
      Object.assign(params, rawParams);
      return handler(params);
    },
  });
}

export function navigate(hash: string) {
  window.location.hash = hash;
}

export function getQueryParams(): Record<string, string> {
  const params: Record<string, string> = {};
  const hash = window.location.hash;
  const qIndex = hash.indexOf('?');
  if (qIndex >= 0) {
    const searchParams = new URLSearchParams(hash.slice(qIndex + 1));
    searchParams.forEach((value, key) => {
      params[key] = value;
    });
  }
  return params;
}

export function startRouter() {
  const render = () => {
    const hash = window.location.hash || '#/';
    const path = hash.slice(1).split('?')[0]; // Remove # and query params
    const queryParams = getQueryParams();
    const app = document.getElementById('app')!;
    const cleanup = currentCleanup;
    currentCleanup = null;
    cleanup?.();

    for (const r of routes) {
      const match = path.match(r.pattern);
      if (match) {
        const result = r.handler({ ...queryParams, _match: match as any });
        app.innerHTML = result.html;
        result.init();
        return;
      }
    }

    // 404 fallback
    app.innerHTML = '<div class="container"><h2>Page not found</h2><a href="#/">Go home</a></div>';
  };

  window.addEventListener('hashchange', render);
  render();
}

export function setCleanup(fn: () => void) {
  currentCleanup = fn;
}
