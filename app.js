'use strict';

const $ = (id) => document.getElementById(id);
const input = $('file-input');
const dropZone = $('drop-zone');
const result = $('result');
const status = $('status');
const resultText = $('result-text');
const preview = $('preview');
const openLink = $('open-link');
const copyButton = $('copy-button');
const title = dropZone.querySelector('.drop-title');
let generation = 0;
let activeWorker = null;
let cancelScan = null;
let imageURL = null;
let copyTimer = null;
let dragDepth = 0;

if (/Mac|iPhone|iPad/.test(navigator.platform)) $('paste-hint').textContent = '⌘ V 粘贴';

function message(text, error = false) {
  status.textContent = text;
  status.classList.toggle('error', error);
}

function releaseImage() {
  preview.removeAttribute('src');
  if (imageURL) URL.revokeObjectURL(imageURL);
  imageURL = null;
}

function stopScan() {
  if (cancelScan) cancelScan();
  activeWorker?.terminate();
  activeWorker = null;
  cancelScan = null;
}

function reset() {
  generation++;
  stopScan();
  releaseImage();
  clearTimeout(copyTimer);
  copyButton.querySelector('span').textContent = '复制';
  dropZone.hidden = false;
  dropZone.classList.remove('loading');
  dropZone.removeAttribute('aria-busy');
  title.textContent = '拖入二维码';
  result.hidden = true;
  resultText.textContent = '';
  openLink.hidden = true;
  openLink.removeAttribute('href');
  input.value = '';
  message('');
}

function decodePixels(worker, pixels, width, height) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(null, new Error('识别超时，请裁剪后重试')), 12000);
    const finish = (value, error) => {
      clearTimeout(timer);
      cancelScan = null;
      worker.onmessage = null;
      worker.onerror = null;
      if (error) reject(error); else resolve(value);
    };
    cancelScan = () => finish(null, new DOMException('Canceled', 'AbortError'));
    worker.onmessage = ({ data }) => data.error ? finish(null, new Error('图片无法识别')) : finish(data.text);
    worker.onerror = (event) => { event.preventDefault(); finish(null, new Error('解码器未能加载，请刷新重试')); };
    worker.postMessage({ pixels: pixels.buffer, width, height }, [pixels.buffer]);
  });
}

async function decodeImage(image, token) {
  const width = image.naturalWidth;
  const height = image.naturalHeight;
  if (!width || !height) throw new Error('图片无法读取');
  if (width * height > 64000000 || Math.max(width, height) > 32000) throw new Error('图片太大，请裁剪后重试');

  // Native detection is an optional fast path; the bundled decoder is always available.
  if ('BarcodeDetector' in window) {
    try {
      const formats = await BarcodeDetector.getSupportedFormats();
      if (formats.includes('qr_code')) {
        const codes = await Promise.race([
          new BarcodeDetector({ formats: ['qr_code'] }).detect(image),
          new Promise((resolve) => setTimeout(() => resolve([]), 1600))
        ]);
        if (token !== generation) throw new DOMException('Canceled', 'AbortError');
        if (codes.length) return codes[0].rawValue;
      }
    } catch (error) {
      if (error.name === 'AbortError') throw error;
    }
  }
  if (token !== generation) throw new DOMException('Canceled', 'AbortError');

  const worker = new Worker('./decoder-worker.js');
  activeWorker = worker;
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d', { willReadFrequently: true });
  const started = performance.now();
  const scan = async (x, y, cropWidth, cropHeight, targetWidth, targetHeight) => {
    if (token !== generation) throw new DOMException('Canceled', 'AbortError');
    if (performance.now() - started > 45000) throw new Error('识别超时，请裁剪后重试');
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, targetWidth, targetHeight);
    context.drawImage(image, x, y, cropWidth, cropHeight, 0, 0, targetWidth, targetHeight);
    return decodePixels(worker, context.getImageData(0, 0, targetWidth, targetHeight).data, targetWidth, targetHeight);
  };
  try {
    // Try multiple scales so both large codes and small codes in screenshots survive.
    let previousScale = 0;
    for (const edge of [1200, 2400]) {
      const scale = Math.min(1, edge / Math.max(width, height));
      if (scale === previousScale) continue;
      previousScale = scale;
      const text = await scan(0, 0, width, height, Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale)));
      if (text !== null) return text;
    }
    if (Math.max(width, height) > 2400) {
      // Overlapping crops retain the original pixels of small codes in long images.
      const size = 1600;
      const stride = 1100;
      const positions = (length) => {
        const list = [0];
        for (let offset = stride; offset + size < length; offset += stride) list.push(offset);
        if (length > size) list.push(length - size);
        return [...new Set(list)];
      };
      for (const y of positions(height)) {
        for (const x of positions(width)) {
          const cropWidth = Math.min(size, width - x);
          const cropHeight = Math.min(size, height - y);
          const text = await scan(x, y, cropWidth, cropHeight, cropWidth, cropHeight);
          if (text !== null) return text;
        }
      }
    }
    return null;
  } finally {
    worker.terminate();
    if (activeWorker === worker) activeWorker = null;
    canvas.width = canvas.height = 1;
  }
}

async function readFile(file) {
  if (!file) return;
  reset();
  const token = generation;
  if (!file.type.startsWith('image/') && !/\.(png|jpe?g|webp|gif|bmp|avif|svg|ico)$/i.test(file.name)) {
    message('请选择图片', true);
    return;
  }
  if (file.size > 30 * 1024 * 1024) {
    message('图片太大，请裁剪后重试', true);
    return;
  }
  dropZone.classList.add('loading');
  dropZone.setAttribute('aria-busy', 'true');
  title.textContent = '识别中';
  message('');
  const objectURL = URL.createObjectURL(file);
  imageURL = objectURL;
  const image = new Image();
  try {
    image.src = objectURL;
    await image.decode();
    if (token !== generation) return;
    const text = await decodeImage(image, token);
    if (token !== generation) return;
    if (text === null) {
      message('未找到二维码，换张图片试试', true);
      releaseImage();
      return;
    }
    resultText.textContent = text;
    preview.src = objectURL;
    const trimmed = text.trim();
    try {
      const url = new URL(trimmed);
      if (/^https?:\/\//i.test(trimmed) && ['https:', 'http:'].includes(url.protocol) && !/\s/.test(trimmed)) {
        openLink.href = url.href;
        openLink.hidden = false;
      }
    } catch { /* Non-URL QR contents stay plain text. */ }
    dropZone.hidden = true;
    result.hidden = false;
    message('');
    copyButton.focus({ preventScroll: true });
  } catch (error) {
    if (token !== generation || error.name === 'AbortError') return;
    message(error.name === 'EncodingError' ? '图片无法读取，换张图片试试' : error.message || '图片无法读取', true);
    releaseImage();
  } finally {
    if (token === generation) {
      dropZone.classList.remove('loading');
      dropZone.removeAttribute('aria-busy');
      title.textContent = '拖入二维码';
    }
    input.value = '';
  }
}

dropZone.addEventListener('click', () => input.click());
input.addEventListener('change', () => readFile(input.files[0]));
$('reset-button').addEventListener('click', () => { reset(); dropZone.focus(); });

copyButton.addEventListener('click', async () => {
  const text = resultText.textContent;
  try {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
    else throw new Error('fallback');
  } catch {
    const field = document.createElement('textarea');
    field.value = text;
    field.style.cssText = 'position:fixed;opacity:0;left:0;top:0;';
    document.body.append(field);
    field.select();
    let copied = false;
    try { copied = document.execCommand('copy'); } finally { field.remove(); copyButton.focus(); }
    if (!copied) { message('请选中文字复制', true); return; }
  }
  copyButton.querySelector('span').textContent = '已复制';
  clearTimeout(copyTimer);
  copyTimer = setTimeout(() => { copyButton.querySelector('span').textContent = '复制'; }, 1600);
});

const isFileDrag = (event) => Array.from(event.dataTransfer?.types || []).includes('Files');
document.addEventListener('dragenter', (event) => {
  if (!isFileDrag(event)) return;
  event.preventDefault();
  dragDepth++;
  document.body.classList.add('is-dragging');
});
document.addEventListener('dragover', (event) => {
  if (!isFileDrag(event)) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'copy';
});
document.addEventListener('dragleave', (event) => {
  if (!isFileDrag(event)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) document.body.classList.remove('is-dragging');
});
document.addEventListener('drop', (event) => {
  event.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('is-dragging');
  const files = Array.from(event.dataTransfer?.files || []);
  readFile(files.find((file) => file.type.startsWith('image/')) || files[0]);
});
window.addEventListener('blur', () => { dragDepth = 0; document.body.classList.remove('is-dragging'); });
document.addEventListener('paste', (event) => {
  const items = Array.from(event.clipboardData?.items || []);
  const image = items.find((item) => item.type.startsWith('image/'));
  if (image) { event.preventDefault(); readFile(image.getAsFile()); }
});
