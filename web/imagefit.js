// Make a picture fit, rather than refusing it.
//
// Every upload on this site has two numbers that were being answered with one: what somebody may
// CHOOSE, and what the server KEEPS. A picture off a phone or out of a design tool is megabytes,
// and telling that person to go and shrink it themselves is telling them to go away. The canvas
// reduces it here, in their browser, and the server still receives only bytes it checks itself.
//
// A classic script rather than a module, deliberately: the front page loads it beside app.js, which
// is a classic script and cannot import, and the coin page loads it beside a module that can still
// read the global. One implementation, two pages, no copy to drift.

(function () {
  'use strict';

  /**
   * @param {File|Blob} file
   * @param {object} lim
   * @param {number} lim.maxBytes        what may be stored, after reduction
   * @param {number} lim.maxSide         the longest side allowed
   * @param {string[]} [lim.formats]     mime types that may be sent untouched
   * @param {number} [lim.maxSourceBytes] what may be chosen at all
   * @returns {Promise<{blob?:Blob, changed?:boolean, w?:number, h?:number, error?:string}>}
   */
  async function vgFitImage(file, lim) {
    if (lim.maxSourceBytes && file.size > lim.maxSourceBytes) {
      const mb = (lim.maxSourceBytes / 1024 / 1024).toFixed(0);
      return { error: `${file.name} is ${(file.size / 1024 / 1024).toFixed(1)} MB, and the most that can be read is ${mb} MB` };
    }

    let bmp;
    try { bmp = await createImageBitmap(file); }
    catch (_) { return { error: `${file.name} is not an image this browser can read` }; }

    const oversized = bmp.width > lim.maxSide || bmp.height > lim.maxSide;
    const known = !lim.formats || lim.formats.includes(file.type);

    // ALREADY SMALL ENOUGH, BUT NOT ALREADY WEBP.
    //
    // A JPEG under the ceiling used to be sent exactly as it arrived, which left collections of
    // JPEGs going onto the chain heavier than they had to be, and made a folder of mixed formats
    // fail the one-format rule for no reason. So it is offered a WEBP of itself at native size and
    // high quality, and that is taken only if it is MEANINGFULLY smaller: a re-encode is a
    // generation loss, and paying it for two per cent is a bad trade.
    if (!oversized && file.size <= lim.maxBytes && known) {
      if (file.type === 'image/webp') {
        if (bmp.close) bmp.close();
        return { blob: file, changed: false, w: bmp.width, h: bmp.height };
      }
      const lighter = await reEncode(bmp, bmp.width, bmp.height, 0.94);
      const worthIt = lighter && lighter.size <= lim.maxBytes && lighter.size < file.size * 0.9;
      const out = worthIt
        ? { blob: lighter, changed: true, w: bmp.width, h: bmp.height, recoded: true }
        : { blob: file, changed: false, w: bmp.width, h: bmp.height };
      if (bmp.close) bmp.close();
      return out;
    }

    const scale = Math.min(1, lim.maxSide / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));

    for (const q of [0.92, 0.85, 0.75, 0.65, 0.5]) {
      const blob = await reEncode(bmp, w, h, q);
      if (blob && blob.size <= lim.maxBytes) {
        if (bmp.close) bmp.close();
        return { blob, changed: true, w, h, recoded: true };
      }
    }
    if (bmp.close) bmp.close();
    return { error: `${file.name} will not fit in ${Math.round(lim.maxBytes / 1024)} KB even reduced` };
  }

  /** One WEBP of a bitmap at a chosen size and quality. */
  function reEncode(bmp, w, h, quality) {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    // Downscaling wants smoothing; art redrawn at its own size does not, and smoothing it there
    // would blur a pixel grid for nothing.
    ctx.imageSmoothingEnabled = w !== bmp.width || h !== bmp.height;
    ctx.drawImage(bmp, 0, 0, w, h);
    return new Promise((r) => canvas.toBlob(r, 'image/webp', quality));
  }

  window.vgFitImage = vgFitImage;
})();
