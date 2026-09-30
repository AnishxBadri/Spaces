/**
 * Ordered dithering, the one place Instrument gets tone. Where another site
 * would blur or fade, this one quantises: an 8×8 Bayer matrix turns a picture
 * into ink dots on paper.
 *
 * A figure is printed by a sweep: a 1-bit plate lies over the picture, and a
 * line moves down it; above the line the plate is clipped away and the
 * picture shows in full colour. The hero sweeps on a timer, the feature
 * figures on scroll, through the same `sweep()`. The plate is dithered once;
 * a sweep frame changes one clip, it never re-dithers. The hero field
 * (field.ts) runs the same matrix in a fragment shader.
 */

/** `?dither-timing` logs what the effects cost, to the console. */
export const DEBUG = location.search.includes('dither-timing')

/** The 8×8 Bayer thresholds, 0…63, row-major, built by recursive tiling. */
export const BAYER8: Uint8Array = (() => {
  let m = [0]
  for (let n = 1; n < 8; n *= 2) {
    const next: number[] = []
    for (let y = 0; y < 2 * n; y++) {
      for (let x = 0; x < 2 * n; x++) {
        const v = 4 * m[(y % n) * n + (x % n)]
        next.push(v + (y < n ? (x < n ? 0 : 2) : x < n ? 3 : 1))
      }
    }
    m = next
  }
  return Uint8Array.from(m)
})()

// A pixel is paper when its luminance reaches its cell's cut: l/255 plus the
// threshold (b + 0.5)/64 rounds down to 1.
const CUT = Uint16Array.from(BAYER8, (b) =>
  Math.ceil(255 * (1 - (b + 0.5) / 64)),
)

// Ink (#1c1c1a) and paper (#ffffff), packed little-endian ABGR for a
// Uint32Array view on ImageData.
const INK = 0xff1a1c1c
const PAPER = 0xffffffff

/**
 * Print a 1-bit plate of `img` into `canvas`, one dot per CSS pixel of the
 * image's box. The decode and the downscale happen off the main thread
 * (createImageBitmap); what is left here is one read and one pass. Returns
 * the width it printed at, 0 when the box is empty or 2D is unavailable.
 */
export async function plate(
  canvas: HTMLCanvasElement,
  img: HTMLImageElement,
): Promise<number> {
  const w = Math.round(img.clientWidth)
  const h = Math.round(img.clientHeight)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx || w === 0 || h === 0) return 0
  const t0 = performance.now()
  const src = await createImageBitmap(img, {
    resizeWidth: w,
    resizeHeight: h,
    resizeQuality: 'medium',
  }).catch(() => img)
  const t1 = performance.now()
  canvas.width = w
  canvas.height = h
  ctx.drawImage(src, 0, 0, w, h)
  if (src instanceof ImageBitmap) src.close()
  const data = ctx.getImageData(0, 0, w, h)
  const px = data.data
  const out = new Uint32Array(px.buffer)
  for (let y = 0, i = 0; y < h; y++) {
    const row = (y & 7) << 3
    for (let x = 0; x < w; x++, i++) {
      const j = i << 2
      // Rec. 601 luma on the stored (gamma) values, in integer arithmetic.
      const l = (px[j] * 77 + px[j + 1] * 150 + px[j + 2] * 29) >> 8
      out[i] = l >= CUT[row | (x & 7)] ? PAPER : INK
    }
  }
  ctx.putImageData(data, 0, 0)
  if (DEBUG) {
    const main = (performance.now() - t1).toFixed(2)
    const off = (t1 - t0).toFixed(1)
    console.log(
      `[dither] plate ${w}×${h}: ${main} ms main thread, ${off} ms awaiting decode`,
    )
  }
  return w
}

/** Show the picture above `p` (0…1 of the height): clip the plate there. */
export function sweep(canvas: HTMLCanvasElement, p: number): void {
  const clip = `inset(${(p * 100).toFixed(2)}% 0 0 0)`
  if (canvas.style.clipPath !== clip) canvas.style.clipPath = clip
}

export const easeInOut = (t: number): number =>
  t < 0.5 ? 4 * t * t * t : 1 - (2 - 2 * t) ** 3 / 2

/** Run `frame(t)` for t from 0 to 1 over `ms`, on animation frames. */
export function tween(ms: number, frame: (t: number) => void): Promise<void> {
  return new Promise((done) => {
    const start = performance.now()
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / ms)
      frame(t)
      if (t < 1) requestAnimationFrame(tick)
      else done()
    }
    requestAnimationFrame(tick)
  })
}
