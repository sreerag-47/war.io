import * as THREE from 'three';
import { elevation, TERRAINS } from './flow.mjs';

const RELIEF = 4.4;

function noise(x, y) {
  const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return n - Math.floor(n);
}

// Fine engraved marks sit underneath the political overlay so the terrain is still legible.
function landTexture(island, cells) {
  const pixels = 12;
  const canvas = document.createElement('canvas');
  canvas.width = island.width * pixels;
  canvas.height = island.height * pixels;
  const ctx = canvas.getContext('2d');
  for (let y = 0; y < island.height; y++) {
    for (let x = 0; x < island.width; x++) {
      const terrain = cells[y * island.width + x].terrain;
      ctx.fillStyle = TERRAINS[terrain].color;
      ctx.fillRect(x * pixels, y * pixels, pixels, pixels);
    }
  }
  // Soften class boundaries but keep the terrain symbols sharp.
  const paper = document.createElement('canvas');
  paper.width = canvas.width;
  paper.height = canvas.height;
  const ink = paper.getContext('2d');
  ink.filter = 'blur(4px)';
  ink.drawImage(canvas, 0, 0);
  ink.filter = 'none';
  for (let y = 1; y < island.height - 1; y++) {
    for (let x = 1; x < island.width - 1; x++) {
      const terrain = cells[y * island.width + x].terrain;
      const n = noise(x, y);
      const px = (x + 0.24 + noise(x + 6, y) * 0.53) * pixels;
      const py = (y + 0.24 + noise(x, y + 8) * 0.53) * pixels;
      if (terrain === 'forest' && n > 0.60) {
        // A pair of tiny asymmetric fir crowns, with sun-facing edges.
        for (let tree = 0; tree < 2; tree++) {
          const cx = px + tree * 3.8;
          const cy = py + tree * 2.2;
          const size = 2.4 + n;
          ink.beginPath();
          ink.moveTo(cx, cy - size);
          ink.lineTo(cx - size * 0.65, cy + size * 0.70);
          ink.lineTo(cx + size * 0.78, cy + size * 0.48);
          ink.closePath();
          ink.fillStyle = 'rgba(25,66,51,.49)';
          ink.fill();
          ink.beginPath();
          ink.moveTo(cx - size * 0.65, cy + size * 0.70);
          ink.lineTo(cx, cy - size);
          ink.strokeStyle = 'rgba(230,239,196,.62)';
          ink.lineWidth = 0.85;
          ink.stroke();
        }
      } else if (terrain === 'highlands' && n > 0.78) {
        ink.strokeStyle = 'rgba(75,62,45,.49)';
        ink.lineWidth = 1.3;
        ink.beginPath();
        ink.moveTo(px - 3.6, py + 1.7);
        ink.lineTo(px, py - 2.8);
        ink.lineTo(px + 2.8, py + 1.3);
        ink.stroke();
      } else if (terrain === 'plains' && n > 0.80) {
        ink.fillStyle = 'rgba(88,108,60,.40)';
        ink.fillRect(px, py, 2.5, 1);
        ink.fillRect(px + 3.5, py - 1, 1.5, 1);
      }
    }
  }
  const texture = new THREE.CanvasTexture(paper);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.flipY = false;
  return texture;
}

const vertexShader = /* glsl */ `
  attribute float relief;
  uniform vec2 dimensions;
  varying vec2 vCell;
  varying float vHeight;
  varying vec3 vUp;
  void main() {
    vCell = position.xz + dimensions * 0.5;
    vHeight = relief;
    vUp = normal;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.);
  }
`;
const fragmentShader = /* glsl */ `
  uniform vec2 dimensions;
  uniform sampler2D paper;
  uniform sampler2D ownership;
  uniform sampler2D palette;
  uniform float paletteWidth;
  uniform float gameTime;
  uniform float isSpreading;
  varying vec2 vCell;
  varying float vHeight;
  varying vec3 vUp;

  float gridLine(vec2 v) {
    vec2 d = abs(fract(v + 0.5) - 0.5) / max(fwidth(v), vec2(0.0001));
    return 1. - smoothstep(0.1, 0.95, min(d.x, d.y));
  }
  float contour(float v) {
    float d = abs(fract(v + 0.5) - 0.5) / max(fwidth(v), 0.0001);
    return 1. - smoothstep(0.1, 1.15, d);
  }
  float weightFor(float id, vec4 ids, vec4 w) {
    return dot(vec4(1.) - step(vec4(0.5), abs(ids - id)), w);
  }
  vec3 politicalColor(vec3 reliefColor) {
    // Interpolate in world space between cell centers. The animation threshold
    // passes through the four arrival times continuously even between simulation steps.
    vec2 uv = vCell - 0.5;
    uv += 0.12 * vec2(sin(vCell.y * 1.18 + vCell.x * .38),
                      cos(vCell.x * .96 - vCell.y * .44));
    vec2 base = floor(uv) + 0.5;
    vec2 f = fract(uv);
    vec4 a = texture2D(ownership, base / dimensions) * 255.;
    vec4 b = texture2D(ownership, (base + vec2(1., 0.)) / dimensions) * 255.;
    vec4 c = texture2D(ownership, (base + vec2(0., 1.)) / dimensions) * 255.;
    vec4 d = texture2D(ownership, (base + vec2(1., 1.)) / dimensions) * 255.;
    vec4 ids = floor(vec4(a.r, b.r, c.r, d.r) + 0.5);
    vec4 w = vec4((1.-f.x)*(1.-f.y), f.x*(1.-f.y), (1.-f.x)*f.y, f.x*f.y);
    vec4 votes = vec4(weightFor(ids.x, ids, w), weightFor(ids.y, ids, w),
                      weightFor(ids.z, ids, w), weightFor(ids.w, ids, w));
    float majority = max(max(votes.x, votes.y), max(votes.z, votes.w));
    float id = votes.x == majority ? ids.x : votes.y == majority ? ids.y :
               votes.z == majority ? ids.z : ids.w;
    if (id < 0.5) return reliefColor;
    vec3 pigment = texture2D(palette, vec2((id - 0.5)/paletteWidth, 0.5)).rgb;
    vec4 dry = step(vec4(0.5), ids);
    vec4 times = (vec4(a.g, b.g, c.g, d.g)*256. + vec4(a.b, b.b, c.b, d.b))/1024.;
    float eta = dot(w * dry, times) / max(dot(w, dry), 0.0001);
    float ahead = gameTime - eta;
    float feather = max(fwidth(eta), 0.055);
    float wet = mix(1., smoothstep(-feather, feather, ahead), isSpreading);
    float movingLip = isSpreading * (1. - smoothstep(0., 0.36, abs(ahead)));
    // Captured ground is occupied immediately, even beside a future flow front.
    vec4 captured = step(vec4(0.5), vec4(a.a, b.a, c.a, d.a));
    float occupied = smoothstep(.35, .65, weightFor(id, ids, w * captured) / majority);
    wet = max(wet, occupied);
    movingLip *= 1. - occupied;
    float border = 1. - smoothstep(0.52, 0.67, majority);
    float shading = clamp(dot(reliefColor, vec3(.21,.72,.07)) * 0.85 + 0.69, 0.65, 1.08);
    vec3 wash = mix(reliefColor, pigment * shading, 0.61);
    vec3 ink = mix(wash, pigment * 0.53, border * 0.83);
    ink = mix(ink, mix(pigment, vec3(1.), .65), movingLip * 0.85);
    return mix(reliefColor, ink, wet);
  }
  void main() {
    float depth = max(0., -vHeight);
    vec3 sea = mix(vec3(.025,.077,.091), vec3(.012,.038,.048), smoothstep(0.,.82,depth));
    float shelf = exp(-depth * 6.5);
    sea += shelf * vec3(.025,.060,.055);
    sea += contour(depth * 11.0) * shelf * vec3(.014,.034,.034);
    sea += gridLine(vCell / 8.) * vec3(.010,.019,.020);
    if (vHeight < -0.012) {
      gl_FragColor = vec4(sea, 1.);
    } else {
      vec3 terrain = texture2D(paper, vCell / dimensions).rgb;
      float lighting = dot(normalize(vUp), normalize(vec3(-.58, .85, -.42)));
      terrain *= .62 + .52 * lighting;
      terrain *= 1. - contour(vHeight * 24.) * smoothstep(.015,.13,vHeight) * .19;
      vec3 ink = politicalColor(terrain);
      float edge = max(fwidth(vHeight) * .75, .003);
      float sand = 1. - smoothstep(.012, .029, vHeight);
      ink = mix(ink, vec3(.81,.75,.54), .65 * sand);
      vec3 color = mix(sea, ink, smoothstep(-edge, edge, vHeight));
      gl_FragColor = vec4(color, 1.);
    }
    #include <colorspace_fragment>
  }
`;

// GPU lookup values are addressed at cell centers. The first byte is the nation
// index + 1, the next two encode arrival time, and the last flags combat claims.
function cellField(island) {
  const texture = new THREE.DataTexture(new Uint8Array(island.width * island.height * 4), island.width, island.height);
  texture.needsUpdate = true;
  return texture;
}

function makeSurface(island) {
  const width = island.width + 2;
  const depth = island.height + 2;
  const geometry = new THREE.PlaneGeometry(width, depth, width * 2, depth * 2);
  geometry.rotateX(-Math.PI / 2);
  const vertices = geometry.attributes.position;
  const heights = new Float32Array(vertices.count);
  const margin = Math.max(island.width, island.height);
  for (let i = 0; i < vertices.count; i++) {
    let x = vertices.getX(i);
    let z = vertices.getZ(i);
    x += Math.sign(x) * Math.max(Math.abs(x) - island.width / 2, 0) * margin;
    z += Math.sign(z) * Math.max(Math.abs(z) - island.height / 2, 0) * margin;
    const height = elevation(x + island.width / 2, z + island.height / 2, island);
    vertices.setXYZ(i, x, Math.max(0, height) * RELIEF, z);
    heights[i] = height;
  }
  geometry.setAttribute('relief', new THREE.BufferAttribute(heights, 1));
  geometry.computeVertexNormals();
  return geometry;
}

// Each tile in the atlas has one channel for the glyph, rim and background.
// The shader tints just the rim, so a captured structure keeps its silhouette.
const BUILDING_ICONS = {
  city: 'M12 48V30H22V18H33V36H38V25H49V48Z M25 22V26H29V22Z M25 30V34H29V30Z',
  factory: 'M12 47V31L23 25V32L34 25V33H39L40 15H47L49 47Z M17 37V41H22V37Z M26 37V41H31V37Z',
  fort: 'M12 47V18H19V24H24V18H31V26H34V18H41V24H46V18H52V47H37V37Q32 30 27 37V47Z',
  port: 'M32 12A7 7 0 1 1 31.99 12 M32 17A2 2 0 1 0 32.01 17 M29 24H35V29H42V34H35V44Q42 43 45 39L41 37L51 31L52 44L48 42Q43 49 32 52Q20 49 16 42L12 44L13 31L23 37L19 39Q22 43 29 44V34H22V29H29Z',
};
const buildingTypes = Object.keys(BUILDING_ICONS);

function buildingMaterial() {
  const atlas = document.createElement('canvas');
  atlas.width = 64 * buildingTypes.length;
  atlas.height = 64;
  const pen = atlas.getContext('2d');
  for (const type of buildingTypes) {
    pen.beginPath();
    pen.roundRect(2, 2, 60, 60, 10);
    pen.fillStyle = '#00ff00';
    pen.fill();
    pen.beginPath();
    pen.roundRect(7, 7, 50, 50, 6);
    pen.fillStyle = '#0000ff';
    pen.fill();
    pen.fillStyle = '#ff0000';
    pen.fill(new Path2D(BUILDING_ICONS[type]), 'evenodd');
    pen.translate(64, 0);
  }
  const texture = new THREE.CanvasTexture(atlas);
  return new THREE.ShaderMaterial({
    uniforms: { atlas: { value: texture }, diameter: { value: 16 } },
    vertexShader: `
      attribute vec3 ownerColor;
      attribute float icon;
      uniform float diameter;
      varying vec3 vOwner;
      varying float vIcon;
      void main() {
        vOwner = ownerColor;
        vIcon = icon;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.);
        gl_PointSize = diameter;
      }
    `,
    fragmentShader: `
      uniform sampler2D atlas;
      varying vec3 vOwner;
      varying float vIcon;
      void main() {
        vec2 uv = vec2((vIcon + gl_PointCoord.x) / 4., 1. - gl_PointCoord.y);
        vec4 stamp = texture2D(atlas, uv);
        if (stamp.a < .05) discard;
        vec3 ink = stamp.r * vec3(1., .95, .78) + stamp.g * vOwner + stamp.b * vec3(.012, .032, .027);
        gl_FragColor = vec4(ink, stamp.a);
        #include <colorspace_fragment>
      }
    `,
    depthTest: false,
    depthWrite: false,
    transparent: true,
  });
}

export function createMapView(viewport, onPick, onInspect = () => {}) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  const canvas = renderer.domElement;
  canvas.tabIndex = 0;
  canvas.setAttribute('aria-label', 'Island map. Use the arrow keys to inspect terrain, then Enter to select.');
  viewport.appendChild(canvas);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#183942');
  const buildings = new THREE.Points(new THREE.BufferGeometry(), buildingMaterial());
  buildings.renderOrder = 11;
  buildings.frustumCulled = false;
  buildings.visible = false;
  scene.add(buildings);
  const camera = new THREE.OrthographicCamera(-53, 53, 35, -35, 0.1, 400);
  camera.position.set(0, 112, 54);
  camera.lookAt(0, 0, 0);

  let island;
  let field;
  const uniforms = {
    dimensions: { value: new THREE.Vector2() },
    paper: { value: null },
    ownership: { value: null },
    palette: { value: null },
    paletteWidth: { value: 1 },
    gameTime: { value: 0 },
    isSpreading: { value: 0 },
  };
  const material = new THREE.ShaderMaterial({ uniforms, vertexShader, fragmentShader });
  let islandMesh;

  function rebuildMap(nextIsland, cells) {
    if (islandMesh) {
      islandMesh.geometry.dispose();
      uniforms.paper.value.dispose();
      field.dispose();
    }

    island = nextIsland;
    uniforms.dimensions.value.set(island.width, island.height);
    uniforms.paper.value = landTexture(island, cells);
    field = cellField(island);
    uniforms.ownership.value = field;

    const surface = makeSurface(island);
    if (islandMesh) {
      islandMesh.geometry = surface;
    } else {
      islandMesh = new THREE.Mesh(surface, material);
      scene.add(islandMesh);
    }
    resize();
  }

  const ray = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const cursor = new THREE.Mesh(
    new THREE.RingGeometry(0.68, 0.85, 32),
    new THREE.MeshBasicMaterial({ color: '#fff8cb', depthTest: false })
  );
  cursor.rotation.x = -Math.PI / 2;
  cursor.visible = false;
  cursor.renderOrder = 10;
  scene.add(cursor);
  let inspected = -1;
  let focusCell = -1;
  let markerGroup;
  let markerSignature;
  let currentGame;
  let painted = -1;
  let buildingRevision = -1;
  let lastMode;

  function positionAt(index, object) {
    const x = index % island.width + 0.5;
    const y = Math.floor(index / island.width) + 0.5;
    object.position.set(x - island.width / 2, Math.max(0, elevation(x, y, island)) * RELIEF + 0.08, y - island.height / 2);
  }

  function syncBuildings(game) {
    if (game.buildingRevision === buildingRevision) return;
    buildingRevision = game.buildingRevision;
    const count = game.buildingCells?.size ?? 0;
    buildings.visible = count > 0;
    if (!count) return;

    let geometry = buildings.geometry;
    if ((geometry.attributes.position?.count ?? 0) < count) {
      const capacity = Math.max(count, 2 * (geometry.attributes.position?.count ?? 8));
      geometry.dispose();
      geometry = new THREE.BufferGeometry();
      for (const [name, width] of [['position', 3], ['ownerColor', 3], ['icon', 1]]) {
        const attribute = new THREE.BufferAttribute(new Float32Array(capacity * width), width);
        geometry.setAttribute(name, attribute.setUsage(THREE.DynamicDrawUsage));
      }
      buildings.geometry = geometry;
    }
    const { position, ownerColor, icon } = geometry.attributes;
    const point = new THREE.Object3D();
    const tint = new THREE.Color();
    let drawn = 0;
    for (const index of game.buildingCells) {
      const cell = game.cells[index];
      const symbol = buildingTypes.indexOf(cell.building);
      if (symbol < 0) continue;
      positionAt(index, point);
      position.setXYZ(drawn, point.position.x, point.position.y, point.position.z);
      tint.set(game.players[cell.owner]?.color ?? '#a3b5a6');
      ownerColor.setXYZ(drawn, tint.r, tint.g, tint.b);
      icon.setX(drawn, symbol);
      drawn++;
    }
    for (const attribute of [position, ownerColor, icon]) {
      attribute.needsUpdate = true;
    }
    geometry.setDrawRange(0, drawn);
  }

  function makeMarkers(players) {
    if (markerGroup) {
      for (const marker of markerGroup.children) {
        marker.material.dispose();
        marker.material.map.dispose();
      }
      scene.remove(markerGroup);
    }
    markerGroup = new THREE.Group();
    scene.add(markerGroup);
    const colors = new Uint8Array(players.length * 4);
    players.forEach((player, index) => {
      const c = new THREE.Color(player.color);
      const srgb = c.getHex();
      colors.set([srgb >> 16, (srgb >> 8) & 255, srgb & 255, 255], index * 4);
      const stamp = document.createElement('canvas');
      stamp.width = stamp.height = 64;
      const pen = stamp.getContext('2d');
      pen.beginPath();
      pen.arc(32, 32, 23, 0, Math.PI * 2);
      pen.fillStyle = '#20312e';
      pen.fill();
      pen.lineWidth = 5;
      pen.strokeStyle = player.color;
      pen.stroke();
      pen.beginPath();
      if (index === 0) {
        pen.moveTo(32, 17);
        pen.lineTo(44, 32);
        pen.lineTo(32, 47);
        pen.lineTo(20, 32);
        pen.closePath();
      } else {
        pen.arc(32, 32, 8, 0, Math.PI * 2);
      }
      pen.fillStyle = '#fcf8d8';
      pen.fill();
      const glyph = new THREE.CanvasTexture(stamp);
      glyph.colorSpace = THREE.SRGBColorSpace;
      const marker = new THREE.Sprite(new THREE.SpriteMaterial({ map: glyph, depthTest: false, transparent: true }));
      marker.renderOrder = 9;
      markerGroup.add(marker);
    });
    uniforms.palette.value?.dispose();
    const texture = new THREE.DataTexture(colors, players.length, 1);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.needsUpdate = true;
    uniforms.palette.value = texture;
    uniforms.paletteWidth.value = players.length;
  }

  function syncField(game) {
    const flow = game.phase === 'expansion' ? game.flow : null;
    // Ordinary expansion animates from the cached forecast. Rebuild it only
    // when combat changes the actual or pending claims.
    const revision = flow ? game.combatRevision : game.revision;
    if (lastMode === game.phase && painted === revision) return;
    const data = field.image.data;
    for (let i = 0; i < game.cells.length; i++) {
      const actual = game.cells[i].owner;
      let id = actual;
      let captured = false;
      let t = 0;
      if (flow) {
        const projected = flow.owner[i];
        t = flow.arrival[i];
        if (actual >= 0) {
          captured = actual !== projected || t > game.elapsed;
        } else if (projected >= 0 && game.players[projected].alive && !game.blockedFlowCells?.has(i)) {
          id = projected;
        }
      }
      const ticks = Number.isFinite(t) ? Math.round(t * 1024) : 65535;
      const offset = i * 4;
      data[offset] = id >= 0 ? id + 1 : 0;
      data[offset + 1] = ticks >> 8;
      data[offset + 2] = ticks & 255;
      data[offset + 3] = captured ? 255 : 0;
    }
    field.needsUpdate = true;
    painted = revision;
    lastMode = game.phase;
  }

  function setInspect(index, showCursor) {
    cursor.visible = showCursor && index >= 0;
    if (cursor.visible) positionAt(index, cursor);
    if (index !== inspected) {
      inspected = index;
      onInspect(index);
    }
  }

  function getIndex(event) {
    if (!islandMesh) return -1;
    const rect = canvas.getBoundingClientRect();
    pointer.set((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1);
    camera.updateMatrixWorld();
    ray.setFromCamera(pointer, camera);
    const hit = ray.intersectObject(islandMesh)[0];
    if (!hit) return -1;
    const x = Math.floor(hit.point.x + island.width / 2);
    const y = Math.floor(hit.point.z + island.height / 2);
    return x >= 0 && x < island.width && y >= 0 && y < island.height ? y * island.width + x : -1;
  }

  canvas.addEventListener('pointermove', event => setInspect(getIndex(event), false));
  canvas.addEventListener('pointerleave', () => setInspect(-1, false));
  canvas.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    const index = getIndex(event);
    if (index >= 0) focusCell = index;
    setInspect(index, false);
    onPick(index);
  });
  canvas.addEventListener('focus', () => setInspect(focusCell, true));
  canvas.addEventListener('blur', () => setInspect(-1, false));
  canvas.addEventListener('keydown', event => {
    if (!island) return;
    const moves = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onPick(focusCell);
    } else if (moves[event.key]) {
      event.preventDefault();
      const [dx, dy] = moves[event.key];
      const x = THREE.MathUtils.clamp(focusCell % island.width + dx, 0, island.width - 1);
      const y = THREE.MathUtils.clamp(Math.floor(focusCell / island.width) + dy, 0, island.height - 1);
      focusCell = y * island.width + x;
      setInspect(focusCell, true);
    }
  });
  canvas.addEventListener('wheel', event => {
    event.preventDefault();
    camera.zoom = THREE.MathUtils.clamp(camera.zoom * Math.exp(-event.deltaY * 0.001), 0.8, 1.8);
    camera.updateProjectionMatrix();
  }, { passive: false });

  function resize() {
    const width = Math.max(1, viewport.clientWidth);
    const height = Math.max(1, viewport.clientHeight);
    renderer.setSize(width, height, false);
    if (!island) return;
    const aspect = width / height;
    const halfHeight = Math.max(island.height * 0.52, island.width * 0.53 / aspect);
    camera.left = -halfHeight * aspect;
    camera.right = halfHeight * aspect;
    camera.top = halfHeight;
    camera.bottom = -halfHeight;
    camera.updateProjectionMatrix();
  }
  new ResizeObserver(resize).observe(viewport);
  resize();

  function reset() {
    lastMode = undefined;
    painted = -1;
    buildingRevision = -1;
    buildings.visible = false;
    focusCell = island ? Math.floor(island.height / 2) * island.width + Math.floor(island.width / 2) : -1;
    camera.zoom = 1;
    camera.updateProjectionMatrix();
    setInspect(-1, false);
  }

  function draw(game) {
    if (currentGame !== game) {
      if (island !== game.island) rebuildMap(game.island, game.cells);
      reset();
      currentGame = game;
      const signature = game.players.map(p => p.color).join(',');
      if (signature !== markerSignature) {
        makeMarkers(game.players);
        markerSignature = signature;
      }
    }
    syncField(game);
    syncBuildings(game);
    uniforms.isSpreading.value = game.phase === 'expansion' ? 1 : 0;
    uniforms.gameTime.value = game.elapsed;
    const worldPerPixel = (camera.top - camera.bottom) / (camera.zoom * Math.max(1, viewport.clientHeight));
    buildings.material.uniforms.diameter.value = THREE.MathUtils.clamp(2.5 / worldPerPixel, 14, 23) * renderer.getPixelRatio();
    game.players.forEach((player, id) => {
      const marker = markerGroup.children[id];
      marker.visible = player.seed != null && game.cells[player.seed]?.owner === id;
      if (marker.visible) {
        positionAt(player.seed, marker);
        marker.scale.setScalar((id === 0 ? 14 : 11) * worldPerPixel);
      }
    });
    renderer.render(scene, camera);
  }

  return { draw, reset };
}
