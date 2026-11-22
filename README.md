# War.io

A browser strategy game set on procedurally generated islands. Place a capital, expand territory, manage population and coins, build infrastructure, and negotiate with rival nations.

Built with JavaScript, Three.js, and Vite.

## Run locally

```sh
npm ci
npm run dev
```

## Checks

```sh
npm test
npm run build
```

## Project structure

- `flow.mjs`: island generation and expansion planning.
- `diplomacy.mjs`: negotiations and diplomatic relationships.
- `game.mjs`: match simulation, economy, buildings, and opponents.
- `map-view.js`: Three.js map rendering.
- `main.js`: input handling and interface updates.

This is a local single-player prototype with bot opponents.
