export function go(path: string) {
  window.history.replaceState(null, '', `#${path}`);
  window.dispatchEvent(new Event('hashchange'));
}

export function click(selector: string) {
  document.querySelector<HTMLElement>(selector)!.click();
}

export function change(id: string, value: string) {
  const el = document.querySelector<HTMLInputElement>(`#${id}`)!;
  el.value = value;
  el.dispatchEvent(new Event('input'));
}

export function submit() {
  document.querySelector('#recipe-form')!.dispatchEvent(new Event('submit', { cancelable: true }));
}
