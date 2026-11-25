import { vi } from 'vitest';

// Controlled hardware adapter. Each test owns and settles its deferred operations.
export function scannerAdapter() {
  const camera = {
    loading: Promise.resolve(),
    startup: () => Promise.resolve(),
    shutdown: () => Promise.resolve(),
    constraints: (_constraints: MediaTrackConstraints): Promise<void> => Promise.resolve(),
  };
  const instances: Scanner[] = [];
  const events: string[] = [];
  class Scanner {
    decode!: (code: string) => void;
    readonly connectedAtConstruction: boolean;
    track = {
      readyState: 'live',
      stop: vi.fn(() => { this.track.readyState = 'ended'; events.push(`release:${this.id}`); }),
      getCapabilities: () => ({ focusMode: ['continuous'], zoom: { min: 1, max: 3 }, torch: true }),
      applyConstraints: vi.fn((constraints: MediaTrackConstraints) => camera.constraints(constraints)),
    };
    constructor(readonly id: string) {
      this.connectedAtConstruction = !!document.getElementById(id)?.isConnected;
      instances.push(this);
    }
    start = vi.fn((_camera: unknown, _config: unknown, decode: (code: string) => void) => {
      events.push(`start:${this.id}`);
      this.decode = decode;
      const video = document.createElement('video');
      Object.defineProperty(video, 'srcObject', {
        configurable: true, writable: true,
        value: { getTracks: () => [this.track], getVideoTracks: () => [this.track] },
      });
      document.getElementById(this.id)!.append(video);
      return camera.startup();
    });
    stop = vi.fn(() => { events.push(`stop:${this.id}`); return camera.shutdown(); });
  }
  const loadScanner = vi.fn(async () => { await camera.loading; return Scanner; });
  return { camera, instances, events, loadScanner };
}
