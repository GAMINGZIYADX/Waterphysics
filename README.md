# RTX Water Balloon

A real-time, ray-traced simulation of a bullet passing through a water balloon, written from scratch in WebGL2 and plain JavaScript. There are no libraries, no build tools and no install step: the whole app is one self-contained HTML file.

It covers the first ~40 ms after impact:

- the latex punctures and tears into radial cracks, then peels back and falls away as shredded rubber;
- the water keeps the bullet's momentum, opens a cavity behind it and bursts out of the exit hole;
- the water holds its shape briefly, then breaks into ligaments and droplets, with mist and a crown splash on the floor.

## Quick start

Download or clone the repo, then run the launcher for your OS:

| OS | Command |
| --- | --- |
| Windows | double-click `run.bat` |
| Linux / macOS | `./run.sh` |
| Any (Python 3) | `python3 run.py` |

The launcher does four things:

- starts a small local web server on `http://127.0.0.1:8731`;
- opens your browser;
- reuses the server if one is already running;
- picks a free port if 8731 is taken.

Options: `run.py --port 9000 --no-browser`.

No Python? The launchers fall back to opening `water_balloon.html` directly, which works in most browsers.

> **First load takes a while.** The path-tracing shaders are large. On Windows (ANGLE/D3D), compiling them takes about **15–25 seconds** the first time. The compile runs in the background with a seconds counter on screen, and the physics simulates meanwhile. After that the browser caches the compiled shaders, and later loads take under a second.

### Requirements

- A browser with **WebGL2** and the extensions `EXT_color_buffer_float`, `OES_texture_float_linear` and `EXT_float_blend`. Current Chrome, Edge and Firefox all qualify.
- A discrete GPU is recommended. Frame time was about 9–12 ms at 1280×720 on the development machine.

## Controls

| Input | Action |
| --- | --- |
| Left-drag | Orbit the camera |
| Right-drag / Shift-drag | Pan |
| Wheel / pinch | Zoom |
| `Space` | Freeze / play |
| `←` / `→` | Step one frame back / forward |
| `R` | Restart the shot |
| `1`–`7` | Camera views: Hero, Side, Exit side, Low, Top, Wide, Floor splash |
| `F` | Toggle auto-framing |
| `H` | Hide / show the control panel |

The timeline at the bottom can be scrubbed. When a frame is frozen, the renderer keeps accumulating samples until it reaches *Frozen-frame samples*. While frozen, it also adds depth of field (*Aperture*) and motion blur (*Shutter*).

## Projectiles

Each preset has its own bullet model, built from real dimensions and drawn to scale against the balloon (7.5 cm radius by default). Mass and speed set the impact energy, and the energy drives the cavity size, how fast the balloon tears and how violent the burst is.

| Preset | Projectile | Mass | Calibre | Speed |
| --- | --- | --- | --- | --- |
| `.177 pellet` | Diabolo air-rifle pellet, lead | 0.53 g | 4.5 mm | 240 m/s |
| `.22 LR` | Round-nose lead | 2.6 g | 5.7 mm | 330 m/s |
| `9 mm` | 124 gr FMJ, short round nose, copper jacket | 8.0 g | 9.01 mm | 360 m/s |
| `5.56 NATO` | M855 spitzer with boat-tail | 4.0 g | 5.7 mm | 930 m/s |
| `7.62 NATO` | M80 ball, pointed with a visible jacket | 9.5 g | 7.82 mm | 840 m/s |
| `.50 BMG` | M33 ball, very large and long | 42.8 g | 12.95 mm | 887 m/s |

Speed, mass, calibre and shot height can also be set by hand in the panel.

## Settings

The side panel groups every parameter:

- **Projectile:** preset, speed, mass, calibre, shot height.
- **Balloon:** radius, height above the floor, latex retraction speed, colour, opacity, clarity.
- **Physics:** gravity, cavity violence, surface tension, viscosity, particle count, surface smoothing.
- **Spray & mist:** droplet amount, mist, cavitation bubbles.
- **Lighting:** photon-traced caustics, key softbox, backlight strip, ambient, backdrop, exposure.
- **Camera:** field of view, render resolution, frozen-frame samples, micro-detail, aperture, shutter, bloom, grain, vignette.

Changing a physics setting re-runs the simulation in the background. Lighting and camera settings apply immediately.

## How it works

### Simulation (Web Worker, baked ahead of playback)

- **Water:** position-based fluid (PBF) particles. The bullet pushes the water aside through a cavity model plus a line-source blast outflow, scaled by the energy it deposits.
- **Latex membrane** (`src/membrane.js`): a pre-stretched icosphere with about 10k vertices.
  - Cracks start at the entry hole and grow as radial polylines, splitting the mesh as they pass.
  - The freed skin pulls back under near-constant tension, so a Taylor–Culick rim forms.
  - The integrator is explicit while the balloon tears, then switches to XPBD.
  - Overstretched rubber fractures, and detached pieces fall under gravity and air drag.
- **Spray & mist:** droplet and mist particles are emitted at the entry and exit holes. There is more of both at the exit, and the amount grows with calibre.

### Rendering (fragment-shader ray tracer)

- The water surface is found by marching an isosurface through a 3D density field splatted from the particles. It is shaded with refraction, reflection and Beer–Lambert absorption.
- The intact latex is an analytic shell, deformed by a cube map of ripples and bulge. The peeled latex is drawn as a mesh with thickness-based translucency and a satin sheen.
- Bullets are revolved meshes with jacket, lead and cannelure materials.
- **Temporal anti-aliasing and upsampling:**
  - Sub-pixel jitter follows a Halton sequence.
  - The previous frame is reprojected using depth and per-object motion vectors.
  - History colours are clipped with YCoCg variance clipping.
  - The final image is resolved at the full devicePixelRatio display resolution.
- Floor caustics are photon traced, with bloom, grain and vignette as a final pass.

## Project layout

```
water_balloon.html   the built app (single file, open this)
run.py / run.bat / run.sh   cross-platform launchers
build.sh             assembles water_balloon.html from src/
build_artifact.py    variant without the <html>/<body> skeleton, for embedding
tools/devserver.py   dev server with a POST /capture endpoint for screenshots
src/
  head.html          page markup and CSS
  shared.js          constants, bullet table, physics helpers (shared with the worker)
  membrane.js        latex tearing simulation
  sim.js             fluid simulation worker
  spray.js           spray / mist emission
  render.js          WebGL2 passes: trace, rubber, bullet, drops, TAA, bloom
  glsl_*.js          shader sources (scene, trace, rubber, fx, caustics, common)
  app_core.js        presets, settings spec, frame store, bullet mesh builder
  app_ui.js          UI, camera, playback, input
```

## Building

`water_balloon.html` is generated. Edit the files in `src/`, then rebuild:

```bash
sh build.sh
```

An optional argument sets the output path: `sh build.sh out/page.html`.

## Known limitations

- The first-ever load is slow on Windows while the shaders compile (see above). Browsers without `KHR_parallel_shader_compile` freeze the page during that compile.
- The simulation is baked before playback, so a new shot or a physics change takes a few seconds to compute.
- Visual realism is good but not photographic. The fluid resolution caps how fine the ligaments and droplets can get.
