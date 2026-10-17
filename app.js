'use strict';

const $ = (id) => document.getElementById(id);
const t = window.i18n.t;
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
let messageKey = '';
let copyFeedback = false;

const languageButton = $('language-button');
const languageMenu = $('language-menu');
const languageNames = { 'zh-Hans': '简体中文', 'zh-Hant': '繁體中文', en: 'English', ja: '日本語', ko: '한국어', es: 'Español', fr: 'Français', de: 'Deutsch', pt: 'Português' };

function applyLanguage() {
  document.documentElement.lang = window.i18n.language;
  document.title = t('pageTitle');
  document.querySelectorAll('[data-i18n]').forEach((element) => {
    element.textContent = t(element.getAttribute('data-i18n'));
  });
  for (const attribute of ['aria-label', 'title', 'alt', 'content']) {
    document.querySelectorAll(`[data-i18n-${attribute}]`).forEach((element) => {
      element.setAttribute(attribute, t(element.getAttribute(`data-i18n-${attribute}`)));
    });
  }
  title.textContent = t(dropZone.classList.contains('loading') ? 'decoding' : 'dropTitle');
  copyButton.querySelector('span').textContent = t(copyFeedback ? 'copied' : 'copy');
  status.textContent = messageKey ? t(messageKey) : '';
  languageButton.querySelector('use').setAttribute('href', `./flags.svg#flag-${window.i18n.language}`);
  const label = `${t('chooseLanguage')}: ${languageNames[window.i18n.language]}`;
  languageButton.setAttribute('aria-label', label);
  languageButton.title = label;
  languageMenu.querySelectorAll('[data-language]').forEach((button) => {
    button.setAttribute('aria-checked', String(button.dataset.language === window.i18n.preference));
  });
}

function setMenu(open, restoreFocus = false) {
  languageMenu.hidden = !open;
  languageButton.setAttribute('aria-expanded', String(open));
  if (open) languageMenu.querySelector('[aria-checked="true"]').focus();
  else if (restoreFocus) languageButton.focus();
}

languageButton.addEventListener('click', () => setMenu(languageMenu.hidden));
languageButton.addEventListener('keydown', (event) => {
  if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
  event.preventDefault();
  setMenu(true);
  if (event.key === 'ArrowUp') languageMenu.lastElementChild.focus();
});
languageMenu.addEventListener('click', (event) => {
  const button = event.target.closest('[data-language]');
  if (!button) return;
  window.i18n.setLanguage(button.dataset.language);
  setMenu(false, true);
});
languageMenu.addEventListener('keydown', (event) => {
  const buttons = [...languageMenu.querySelectorAll('[data-language]')];
  const index = buttons.indexOf(document.activeElement);
  let next;
  if (['ArrowDown', 'ArrowRight'].includes(event.key)) next = (index + 1) % buttons.length;
  else if (['ArrowUp', 'ArrowLeft'].includes(event.key)) next = (index - 1 + buttons.length) % buttons.length;
  else if (event.key === 'Home') next = 0;
  else if (event.key === 'End') next = buttons.length - 1;
  if (next !== undefined) { event.preventDefault(); buttons[next].focus(); }
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !languageMenu.hidden) { event.preventDefault(); setMenu(false, true); }
});
document.addEventListener('pointerdown', (event) => {
  if (!event.target.closest('.language-switch')) setMenu(false);
});
document.addEventListener('focusin', (event) => {
  if (!event.target.closest('.language-switch')) setMenu(false);
});
window.addEventListener('qr-languagechange', applyLanguage);
window.addEventListener('languagechange', () => {
  if (window.i18n.preference === 'auto') window.i18n.setLanguage('auto');
});
applyLanguage();

function message(key, error = false) {
  messageKey = key;
  status.textContent = key ? t(key) : '';
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
  copyFeedback = false;
  copyButton.querySelector('span').textContent = t('copy');
  dropZone.hidden = false;
  dropZone.classList.remove('loading');
  dropZone.removeAttribute('aria-busy');
  title.textContent = t('dropTitle');
  result.hidden = true;
  resultText.textContent = '';
  openLink.hidden = true;
  openLink.removeAttribute('href');
  input.value = '';
  message('');
}

function decodePixels(worker, pixels, width, height) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(null, new Error('timeout')), 12000);
    const finish = (value, error) => {
      clearTimeout(timer);
      cancelScan = null;
      worker.onmessage = null;
      worker.onerror = null;
      if (error) reject(error); else resolve(value);
    };
    cancelScan = () => finish(null, new DOMException('Canceled', 'AbortError'));
    worker.onmessage = ({ data }) => data.error ? finish(null, new Error('unreadable')) : finish(data.text);
    worker.onerror = (event) => { event.preventDefault(); finish(null, new Error('decoderFailed')); };
    worker.postMessage({ pixels: pixels.buffer, width, height }, [pixels.buffer]);
  });
}

async function decodeImage(image, token) {
  const width = image.naturalWidth;
  const height = image.naturalHeight;
  if (!width || !height) throw new Error('unreadable');
  if (width * height > 64000000 || Math.max(width, height) > 32000) throw new Error('tooLarge');

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
    if (performance.now() - started > 45000) throw new Error('timeout');
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
    message('chooseImage', true);
    return;
  }
  if (file.size > 30 * 1024 * 1024) {
    message('tooLarge', true);
    return;
  }
  dropZone.classList.add('loading');
  dropZone.setAttribute('aria-busy', 'true');
  title.textContent = t('decoding');
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
      message('notFound', true);
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
    const errorKey = ['timeout', 'unreadable', 'decoderFailed', 'tooLarge'].includes(error.message) ? error.message : 'unreadable';
    message(errorKey, true);
    releaseImage();
  } finally {
    if (token === generation) {
      dropZone.classList.remove('loading');
      dropZone.removeAttribute('aria-busy');
      title.textContent = t('dropTitle');
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
    if (!copied) { message('copyManually', true); return; }
  }
  copyFeedback = true;
  copyButton.querySelector('span').textContent = t('copied');
  clearTimeout(copyTimer);
  copyTimer = setTimeout(() => { copyFeedback = false; copyButton.querySelector('span').textContent = t('copy'); }, 1600);
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
