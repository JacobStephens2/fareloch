import { afterEach, expect, it, vi } from 'vitest';
import { route, startRouter } from '../router';
import { logFoodView } from './log-food';
import { go, click } from '../test/recipe-editor-fixtures';
import { deferred } from '../test/food-search-fixtures';

vi.mock('../api', () => ({ foods: { recent: vi.fn().mockResolvedValue({ foods: [] }) }, meals: {}, recipes: {} }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('releases a real adapter stream when aspect ratio constraints reject after departure', async () => {
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
  const constraints = deferred<void>();
  const track = {
    readyState: 'live',
    applyConstraints: vi.fn(() => constraints.promise),
    stop: vi.fn(() => { track.readyState = 'ended'; }),
  };
  const stream = { getVideoTracks: () => [track], getTracks: () => [track] };
  const getUserMedia = vi.fn().mockResolvedValue(stream);
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } });
  document.body.innerHTML = '<div id="app"></div>';
  window.history.replaceState(null, '', '#/other');
  route('/log', logFoodView);
  route('/other', () => ({ html: '<p>Other</p>', init() {} }));
  startRouter();
  go('/log');
  click('#scan-btn');
  await vi.waitFor(() => expect(track.applyConstraints).toHaveBeenCalledWith({ aspectRatio: 1.777778 }));
  const host = document.querySelector('[id^="log-food-camera-"]')!;
  go('/other');
  const current = document.querySelector('#app')!.innerHTML;
  constraints.reject(new DOMException('Unsupported aspect ratio', 'OverconstrainedError'));
  await vi.waitFor(() => expect(host.parentElement).toBeNull());
  expect(document.querySelector('#app')!.innerHTML).toBe(current);
  expect(track.readyState).toBe('ended');
});
