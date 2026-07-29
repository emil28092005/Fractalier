# Fractalier

**Breed evolving mathematical fractals through selection, crossover, and mutation.**

[Play on itch.io](https://emil-shanaty.itch.io/fractalier) · [Open the GitHub Pages version](https://emil28092005.github.io/Fractalier/)

Fractalier is an interactive procedural fractal generator built around selective evolution. Choose two formulas from your collection, decide how strongly each parent should influence the result, set the mutation intensity, and generate a new descendant.

Every fractal is produced from a mathematical genome rather than a fixed image. Its genome controls recursion, branching, symmetry, curves, trigonometric modulation, geometric segments, color, gradients, and spatial layout.

## Features

- Select and cross any two formulas from your collection
- Adjustable parent genome proportions and mutation intensity
- Radial and non-radial structures
- Sine, cosine, wave, polygonal, branching, and cyclic forms
- Animated formula previews
- Local collection that persists between visits
- PNG export with or without the background
- WebM growth animation export
- Formula import and export as JSON
- Responsive layouts for desktop, tablet, and mobile
- Procedural rendering with no external runtime dependencies

## How to play

1. Open the Gallery and use the `+` buttons to select parents **A** and **B**.
2. Choose the inheritance ratio and mutation intensity.
3. Press **Cross A × B** or use the <kbd>Space</kbd> key.
4. Keep interesting descendants and use them in future generations.
5. Click a saved formula to view, animate, or export it.

The initial population contains only two founders. New forms must emerge through selection and mutation.

## Local persistence

Your collection is stored in the browser using IndexedDB. It survives page reloads and browser restarts, but it is not synchronized between devices or browsers. Clearing the site's browser data will remove the local collection, so export valuable formulas as JSON if you want a backup.

## Run locally

No installation or build step is required. Serve the repository with any static HTTP server:

```bash
python3 -m http.server 8000
```

Then open [http://localhost:8000](http://localhost:8000).

## Technology

Fractalier is made with vanilla JavaScript, HTML, CSS, Canvas 2D, and IndexedDB. The GitHub Pages deployment is handled automatically by GitHub Actions.

