import { createMountedLifetime } from '../mounted-lifetime';

// The loader varies only the hardware adapter; camera coordination stays private.
type Scanner = {
  start(
    camera: { facingMode: string },
    config: { fps: number; qrbox: { width: number; height: number } },
    onDecode: (code: string) => void,
    onError: (message: string) => void,
  ): Promise<unknown> | void;
  stop(): Promise<unknown> | void;
};
type ScannerConstructor = new (hostId: string) => Scanner;

const loadInstalledScanner = async (): Promise<ScannerConstructor> => (await import('html5-qrcode')).Html5Qrcode;

// Only physical camera ownership is shared between mounted Log Food sessions.
let cameraGate: Promise<void> = Promise.resolve();
let nextCameraHost = 0;

type CameraAttempt = {
  host: HTMLElement;
  cancelled: boolean;
  consumed: boolean;
  code?: string;
  requestClose: () => void;
};

export function mountBarcodeScanner(root: HTMLElement, {
  onBarcode,
  loadScanner = loadInstalledScanner,
  isParentLive = () => true,
}: {
  onBarcode: (code: string) => void;
  loadScanner?: () => Promise<ScannerConstructor>;
  isParentLive?: () => boolean;
}): () => void {
  const find = (id: string) => root.querySelector<HTMLElement>(`#${id}`)!;
  const scannerContainer = find('scanner-container');
  const scannerSlot = find('scanner-video');
  const scanButton = find('scan-btn');
  const closeButton = find('scanner-close');
  let cameraAttempt: CameraAttempt | undefined;
  function cancelCurrentAttempt() {
    if (cameraAttempt) {
      cameraAttempt.cancelled = true;
      cameraAttempt.requestClose();
    }
  }
  // Cleanup is initialized before lifetime construction: a disconnected mount retires immediately.
  const lifetime = createMountedLifetime(root, {
    ownedNodes: [scanButton, scannerContainer, scannerSlot, closeButton],
    cleanup: cancelCurrentAttempt,
  });
  const isLive = () => lifetime.isLive() && isParentLive();
  function on(element: HTMLElement, handler: () => void) {
    element.addEventListener('click', () => {
      if (isLive() && root.contains(element)) handler();
    }, { signal: lifetime.signal });
  }
  const validAttempt = (attempt: CameraAttempt) => isLive() && cameraAttempt === attempt && !attempt.cancelled;

  function closeScanner() {
    cancelCurrentAttempt();
    if (isLive()) scannerContainer.classList.add('hidden');
  }

  // Optional constraints never hold camera release or the next attempt hostage.
  async function enhanceCamera(attempt: CameraAttempt) {
    try {
      const stream = attempt.host.querySelector('video')?.srcObject as MediaStream | null;
      const cameraTrack = stream?.getVideoTracks()[0];
      if (!cameraTrack || !validAttempt(attempt) || attempt.consumed) return;
      // html5-qrcode 2.3.8 applies its aspectRatio option before attaching srcObject.
      // Apply the preference after startup so a rejected constraint leaves owned tracks reachable.
      try { await cameraTrack.applyConstraints({ aspectRatio: 1.777778 }); } catch { /* Optional camera preference. */ }
      if (!validAttempt(attempt) || attempt.consumed) return;
      const caps = cameraTrack.getCapabilities() as MediaTrackCapabilities & {
        focusMode?: string[]; zoom?: { min: number; max: number }; torch?: boolean;
      };
      const advanced: MediaTrackConstraintSet[] = [];
      if (caps.focusMode?.includes('continuous')) advanced.push({ focusMode: 'continuous' } as MediaTrackConstraintSet);
      if (caps.zoom && caps.zoom.min < caps.zoom.max) advanced.push({ zoom: Math.min(1.5, caps.zoom.max) } as MediaTrackConstraintSet);
      try {
        if (advanced.length) await cameraTrack.applyConstraints({ advanced });
      } catch { /* Autofocus/zoom are optional; flashlight may still be supported. */ }
      if (!validAttempt(attempt) || attempt.consumed || !caps.torch) return;
      const toolbar = document.createElement('div');
      toolbar.className = 'scanner-toolbar';
      const button = document.createElement('button');
      button.id = 'torch-btn';
      button.className = 'btn btn-sm btn-outline';
      button.textContent = 'Flashlight';
      toolbar.append(button);
      scannerContainer.insertBefore(toolbar, closeButton);
      let torchOn = false;
      on(button, async () => {
        if (!validAttempt(attempt) || attempt.consumed) return;
        const next = !torchOn;
        try {
          await cameraTrack.applyConstraints({ advanced: [{ torch: next } as MediaTrackConstraintSet] });
          if (!validAttempt(attempt) || attempt.consumed) return;
          torchOn = next;
          button.textContent = torchOn ? 'Flashlight Off' : 'Flashlight';
        } catch { /* Keep the last successfully applied flashlight state. */ }
      });
    } catch { /* Unsupported camera capabilities are nonfatal. */ }
  }

  function openScanner() {
    if (cameraAttempt && !cameraAttempt.cancelled && !cameraAttempt.consumed) {
      closeScanner();
      return;
    }
    scannerContainer.classList.remove('hidden');
    scannerContainer.querySelector('.form-error')?.remove();
    scannerContainer.querySelector('.scanner-toolbar')?.remove();
    const host = document.createElement('div');
    host.id = `log-food-camera-${++nextCameraHost}`;
    scannerSlot.append(host);
    let requestClose!: () => void;
    const closing = new Promise<void>(resolve => { requestClose = resolve; });
    const attempt: CameraAttempt = { host, cancelled: false, consumed: false, requestClose };
    cameraAttempt = attempt;
    const previous = cameraGate;

    async function runCamera() {
      let scanner: Scanner | undefined;
      let started = false;
      const tracks = new Set<MediaStreamTrack>();
      const captureTracks = () => {
        attempt.host.querySelectorAll('video').forEach(video => {
          const stream = video.srcObject as MediaStream | null;
          stream?.getTracks().forEach(track => tracks.add(track));
        });
      };
      try {
        await previous;
        if (!validAttempt(attempt)) return;
        const Scanner = await loadScanner();
        if (!validAttempt(attempt)) return;
        scanner = new Scanner(host.id);
        started = true;
        await scanner.start(
          { facingMode: 'environment' },
          { fps: 15, qrbox: { width: Math.min(window.innerWidth - 40, 300), height: 150 } },
          code => {
            if (!validAttempt(attempt) || attempt.consumed) return;
            attempt.consumed = true;
            attempt.code = code;
            scannerContainer.classList.add('hidden');
            attempt.requestClose();
          },
          () => {},
        );
        if (validAttempt(attempt) && !attempt.consumed) void enhanceCamera(attempt);
        if (validAttempt(attempt) && !attempt.consumed) await closing;
      } catch {
        if (validAttempt(attempt) && !attempt.consumed) {
          const error = document.createElement('p');
          error.className = 'form-error';
          error.textContent = 'Camera access denied or not available.';
          scannerContainer.insertBefore(error, closeButton);
        }
      } finally {
        try {
          captureTracks();
          if (scanner && started) {
            try { await scanner.stop(); } catch { /* Fall back to this host's captured tracks. */ }
          }
        } finally {
          captureTracks();
          for (const track of tracks) {
            try { if (track.readyState !== 'ended') track.stop(); } catch { /* Continue releasing the other owned tracks. */ }
          }
          host.remove();
        }
      }
    }

    // Cleanup always settles the private gate, even if a scanner adapter throws.
    cameraGate = runCamera().catch(() => {});
    void cameraGate.then(() => {
      // A later opening owns the controls, but does not cancel an already accepted barcode.
      if (isLive() && !attempt.cancelled && attempt.code !== undefined) onBarcode(attempt.code);
      if (cameraAttempt === attempt) {
        if (isLive()) scannerContainer.querySelector('.scanner-toolbar')?.remove();
        cameraAttempt = undefined;
      }
    });
  }

  on(scanButton, openScanner);
  on(closeButton, closeScanner);

  return lifetime.dispose;
}
