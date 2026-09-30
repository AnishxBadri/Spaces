/**
 * The hero field: slow value noise quantised through the 8×8 Bayer matrix to
 * 1-bit, a graphite dot or nothing in every 3 CSS px cell. The pointer is a
 * soft light that thins the dots around it. Every change of tone is a change
 * of density, never of alpha: a dot is full graphite or absent. Raw WebGL 1,
 * one fullscreen triangle; no WebGL means no field and an unchanged page.
 */

import { DEBUG } from './dither'

const VERT = `attribute vec2 a;void main(){gl_Position=vec4(a,0.,1.);}`

// R: backing size in px. S: backing px per CSS px. T: seconds.
// P: pointer in CSS px from the bottom-left, and the light's strength 0…1.
// B: the text blocks, CSS px from the bottom-left (x0 y0 x1 y1); the dots
// thin to nothing over 48px as they near a word, so no dot touches a glyph.
// From 60% of the height down the ink probability falls linearly to zero at
// the bottom edge, which is the hero figure's top rule.
const FRAG = `precision highp float;
uniform vec2 R;uniform float S;uniform float T;uniform vec3 P;uniform vec4 B[4];
float h(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
float n(vec2 p){vec2 i=floor(p),f=fract(p);f*=f*(3.-2.*f);
return mix(mix(h(i),h(i+vec2(1,0)),f.x),mix(h(i+vec2(0,1)),h(i+1.),f.x),f.y);}
float b2(vec2 a){a=mod(a,2.);return fract(a.x*.5+a.y*a.y*.75);}
float b8(vec2 a){return b2(a)+b2(floor(a*.5))*.25+b2(floor(a*.25))*.0625;}
void main(){
vec2 p=gl_FragCoord.xy/S,cell=floor(p/3.),c=cell*3.+1.;
float t=T*.314159;vec2 d=vec2(cos(t),sin(t));vec2 q=c/240.;
float f=n(q+d*.2)*.55+n(q*2.3-d*.35+5.2)*.3+n(q*5.1+d.yx*.45+1.7)*.15;
float k=smoothstep(.3,.8,f)*.46*clamp((c.y-1.)/(R.y/S*.4),0.,1.);
k*=1.-P.z*(1.-smoothstep(20.,300.,distance(c,P.xy)));
for(int i=0;i<4;i++){vec2 e=max(max(B[i].xy-c,c-B[i].zw),0.);k*=smoothstep(8.,56.,length(e));}
vec2 o=p-cell*3.;
if(b8(mod(cell,8.))>=k||o.x>=2.||o.y>=2.)discard;
gl_FragColor=vec4(.361,.357,.337,1.);}`

function program(gl: WebGLRenderingContext): WebGLProgram | null {
  const prog = gl.createProgram()
  for (const [type, src] of [
    [gl.VERTEX_SHADER, VERT],
    [gl.FRAGMENT_SHADER, FRAG],
  ] as const) {
    const sh = gl.createShader(type)
    if (!sh) return null
    gl.shaderSource(sh, src)
    gl.compileShader(sh)
    gl.attachShader(prog, sh)
  }
  gl.bindAttribLocation(prog, 0, 'a')
  gl.linkProgram(prog)
  return gl.getProgramParameter(prog, gl.LINK_STATUS) ? prog : null
}

/**
 * Mount the field in `host`, keeping it off the ink of `words` (up to four
 * elements; the box measured is their text, not their block) and ending it
 * exactly at the top edge of `edge` (the hero figure's rule).
 */
export function mountField(
  host: HTMLElement,
  words: Element[],
  edge: Element,
): void {
  const canvas = document.createElement('canvas')
  const gl = canvas.getContext('webgl', {
    alpha: true,
    antialias: false,
    depth: false,
    stencil: false,
    powerPreference: 'low-power',
  })
  if (!gl) return
  const prog = program(gl)
  if (!prog) return
  gl.useProgram(prog)
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer())
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 3, -1, -1, 3]),
    gl.STATIC_DRAW,
  )
  gl.enableVertexAttribArray(0)
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
  const uR = gl.getUniformLocation(prog, 'R')
  const uS = gl.getUniformLocation(prog, 'S')
  const uT = gl.getUniformLocation(prog, 'T')
  const uP = gl.getUniformLocation(prog, 'P')
  const uB = gl.getUniformLocation(prog, 'B')
  const boxes = new Float32Array(16)
  const range = document.createRange()
  const measure = () => {
    const h = host.getBoundingClientRect()
    words.slice(0, 4).forEach((el, i) => {
      range.selectNodeContents(el)
      const r = range.getBoundingClientRect()
      boxes.set(
        [
          r.left - h.left,
          h.bottom - r.bottom,
          r.right - h.left,
          h.bottom - r.top,
        ],
        i * 4,
      )
    })
  }
  host.append(canvas)

  const still = matchMedia('(prefers-reduced-motion: reduce)').matches
  const lit = !still && matchMedia('(hover: hover) and (pointer: fine)').matches
  const scale = Math.min(devicePixelRatio || 1, 1.5)

  // The pointer as last seen (client px), and the light as drawn: it trails
  // the pointer and fades in and out rather than switching.
  let cx = 0
  let cy = 0
  let on = false
  let lx = 0
  let ly = 0
  let ls = 0
  let visible = false
  let raf = 0
  let last = 0
  let drawn = 0
  let sum = 0
  let frames = 0

  const draw = (now: number) => {
    const t0 = performance.now()
    gl.uniform2f(uR, canvas.width, canvas.height)
    gl.uniform1f(uS, scale)
    gl.uniform1f(uT, still ? 0 : now / 1000)
    gl.uniform3f(uP, lx, ly, ls)
    gl.uniform4fv(uB, boxes)
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
    drawn = now
    if (DEBUG) {
      // Reading one pixel waits for the GPU, so this is the frame's real cost.
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4))
      sum += performance.now() - t0
      if (++frames === 60) {
        console.log(`[dither] field frame ${(sum / 60).toFixed(2)} ms avg`)
        sum = frames = 0
      }
    }
  }

  const loop = (now: number) => {
    raf = 0
    if (!visible || document.hidden) return
    raf = requestAnimationFrame(loop)
    const dt = Math.min(64, now - (last || now))
    last = now
    let moving = false
    if (lit) {
      const r = canvas.getBoundingClientRect()
      const tx = cx - r.left
      const ty = r.bottom - cy
      if (ls < 0.01) {
        lx = tx
        ly = ty
      }
      const k = 1 - Math.exp(-dt / 110)
      lx += (tx - lx) * k
      ly += (ty - ly) * k
      const target = on ? 1 : 0
      ls += (target - ls) * (1 - Math.exp(-dt / 260))
      moving =
        Math.abs(tx - lx) + Math.abs(ty - ly) > 0.5 ||
        Math.abs(target - ls) > 0.005
    }
    // The drift is slow enough for 30 fps; the light gets every frame.
    if (moving || now - drawn > 32) draw(now)
  }

  const start = () => {
    if (!still && !raf && visible && !document.hidden) {
      last = 0
      raf = requestAnimationFrame(loop)
    }
  }

  // host is positioned against its parent; its bottom is set to the rule.
  const fit = () => {
    const parent = host.parentElement
    if (!parent) return
    const gap =
      edge.getBoundingClientRect().top - parent.getBoundingClientRect().bottom
    const bottom = `${-gap}px`
    if (host.style.bottom !== bottom) host.style.bottom = bottom
  }
  fit()

  new ResizeObserver(() => {
    fit()
    canvas.width = Math.round(host.clientWidth * scale)
    canvas.height = Math.round(host.clientHeight * scale)
    gl.viewport(0, 0, canvas.width, canvas.height)
    measure()
    draw(performance.now())
  }).observe(host)
  addEventListener('resize', fit)
  // The webfonts change the words' extents once they arrive.
  void document.fonts.ready.then(() => {
    fit()
    measure()
    draw(performance.now())
  })

  new IntersectionObserver((entries) => {
    visible = entries.at(-1)?.isIntersecting ?? false
    start()
  }).observe(host)
  document.addEventListener('visibilitychange', start)

  canvas.addEventListener('webglcontextlost', () => {
    visible = false
    canvas.remove()
  })

  if (lit) {
    addEventListener(
      'pointermove',
      (e) => {
        if (e.pointerType !== 'mouse') return
        cx = e.clientX
        cy = e.clientY
        on = true
      },
      { passive: true },
    )
    document.documentElement.addEventListener('pointerleave', () => {
      on = false
    })
  }
}
