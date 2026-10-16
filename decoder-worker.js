/* jsQR is bundled locally under the Apache-2.0 license. */
importScripts('./vendor/jsQR.js');
self.onmessage = ({ data: { pixels, width, height } }) => {
  try {
    const code = jsQR(new Uint8ClampedArray(pixels), width, height, { inversionAttempts: 'attemptBoth' });
    self.postMessage({ text: code === null ? null : code.data });
  } catch {
    self.postMessage({ error: true });
  }
};
