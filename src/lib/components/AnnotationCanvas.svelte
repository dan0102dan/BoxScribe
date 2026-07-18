<script lang="ts">
  import { createEventDispatcher, onMount } from 'svelte';
  import { clamp, fitViewport, imageToScreen, screenToImage } from '$lib/annotation/coordinates';
  import type { BoundingBox, ImageItem, Viewport } from '$lib/annotation/types';

  export let imageUrl: string;
  export let imageInfo: ImageItem;
  export let boxes: BoundingBox[] = [];
  export let selectedId: string | null = null;
  export let currentClass = 0;
  export let classes: string[] = [];
  export let showLabels = true;
  export let readOnly = false;

  const dispatch = createEventDispatcher<{
    change: BoundingBox[];
    commit: { before: BoundingBox[]; boxes: BoundingBox[] };
    select: string | null;
    viewport: number;
    ready: string;
    loaderror: string;
  }>();
  let canvas: HTMLCanvasElement;
  let host: HTMLDivElement;
  let ctx: CanvasRenderingContext2D;
  let image = new Image();
  let loaded = false;
  let imageLoadSequence = 0;
  let viewport: Viewport = { scale: 1, offsetX: 0, offsetY: 0 };
  let spaceDown = false;
  let action: null | { type: 'pan' | 'create' | 'move' | 'resize'; startX: number; startY: number; before: BoundingBox[]; box?: BoundingBox; handle?: string; startViewport?: Viewport } = null;
  const palette = ['#E9FF70', '#FF8D5C', '#70D6FF', '#D7A7FF', '#77E6A1', '#FFD166', '#FF7A9E', '#B8C0FF', '#F3A6FF'];

  $: if (imageUrl) loadImage(imageUrl);
  $: if (ctx && loaded && boxes && selectedId !== undefined && showLabels !== undefined) draw();

  function loadImage(url: string) {
    const request = ++imageLoadSequence;
    loaded = false;
    draw();
    const candidate = new Image();
    candidate.onload = () => {
      if (request !== imageLoadSequence || url !== imageUrl) return;
      image = candidate; loaded = true; fit(); dispatch('ready', url);
    };
    candidate.onerror = () => { if (request === imageLoadSequence && url === imageUrl) dispatch('loaderror', url); };
    candidate.src = url;
  }

  function resize() {
    if (!canvas || !host) return;
    const ratio = window.devicePixelRatio || 1;
    const rect = host.getBoundingClientRect();
    canvas.width = Math.round(rect.width * ratio);
    canvas.height = Math.round(rect.height * ratio);
    canvas.style.width = `${rect.width}px`;
    canvas.style.height = `${rect.height}px`;
    ctx = canvas.getContext('2d')!;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    if (loaded) fit(); else draw();
  }

  export function fit() {
    if (!host || !loaded) return;
    viewport = fitViewport(host.clientWidth, host.clientHeight, imageInfo.width, imageInfo.height);
    dispatch('viewport', Math.round(viewport.scale * 100));
    draw();
  }

  export function focusSelected() {
    if (!host || !loaded || !selectedId) return;
    const box = boxes.find((item) => item.id === selectedId);
    if (!box || box.width <= 0 || box.height <= 0) return;
    const hostWidth = host.clientWidth, hostHeight = host.clientHeight;
    const imageFitScale = fitViewport(hostWidth, hostHeight, imageInfo.width, imageInfo.height).scale;
    const hostAspect = hostWidth / hostHeight;
    let contextWidth = Math.sqrt(box.width * imageInfo.width);
    let contextHeight = Math.sqrt(box.height * imageInfo.height);
    if (contextWidth / contextHeight < hostAspect) contextWidth = contextHeight * hostAspect;
    else contextHeight = contextWidth / hostAspect;
    const scale = Math.max(imageFitScale, Math.min(hostWidth / contextWidth, hostHeight / contextHeight));
    const scaledWidth = imageInfo.width * scale, scaledHeight = imageInfo.height * scale;
    const centeredX = hostWidth / 2 - (box.x + box.width / 2) * scale;
    const centeredY = hostHeight / 2 - (box.y + box.height / 2) * scale;
    const edgeSpaceX = box.width * scale / 2;
    const edgeSpaceY = box.height * scale / 2;
    viewport = {
      scale,
      offsetX: scaledWidth <= hostWidth ? (hostWidth - scaledWidth) / 2 : clamp(centeredX, hostWidth - scaledWidth - edgeSpaceX, edgeSpaceX),
      offsetY: scaledHeight <= hostHeight ? (hostHeight - scaledHeight) / 2 : clamp(centeredY, hostHeight - scaledHeight - edgeSpaceY, edgeSpaceY)
    };
    dispatch('viewport', Math.round(scale * 100));
    draw();
  }

  function draw() {
    if (!ctx || !host) return;
    const w = host.clientWidth, h = host.clientHeight;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#111419'; ctx.fillRect(0, 0, w, h);
    drawGrid(w, h);
    if (!loaded) return;
    ctx.save();
    ctx.imageSmoothingEnabled = viewport.scale < 4;
    ctx.drawImage(image, viewport.offsetX, viewport.offsetY, imageInfo.width * viewport.scale, imageInfo.height * viewport.scale);
    ctx.restore();
    for (const box of boxes) drawBox(box, box.id === selectedId);
  }

  function drawGrid(w: number, h: number) {
    ctx.strokeStyle = 'rgba(255,255,255,.025)'; ctx.lineWidth = 1; ctx.beginPath();
    for (let x = 0; x < w; x += 24) { ctx.moveTo(x, 0); ctx.lineTo(x, h); }
    for (let y = 0; y < h; y += 24) { ctx.moveTo(0, y); ctx.lineTo(w, y); }
    ctx.stroke();
  }

  function drawBox(box: BoundingBox, selected: boolean) {
    const p = imageToScreen(box.x, box.y, viewport);
    const w = box.width * viewport.scale, h = box.height * viewport.scale;
    const color = palette[box.classId % palette.length];
    ctx.strokeStyle = color; ctx.lineWidth = selected ? 2.5 : 1.75;
    ctx.fillStyle = `${color}${selected ? '1f' : '0d'}`;
    ctx.fillRect(p.x, p.y, w, h); ctx.strokeRect(p.x, p.y, w, h);
    if (showLabels) {
      const label = classes[box.classId] ?? `class ${box.classId}`;
      ctx.font = '600 12px Inter, system-ui';
      const labelWidth = ctx.measureText(label).width + 14;
      ctx.fillStyle = color; ctx.fillRect(p.x, Math.max(0, p.y - 22), labelWidth, 22);
      ctx.fillStyle = '#111318'; ctx.fillText(label, p.x + 7, Math.max(15, p.y - 7));
    }
    if (selected) {
      ctx.fillStyle = '#fff'; ctx.strokeStyle = color; ctx.lineWidth = 2;
      for (const [hx, hy] of handles(box)) { ctx.beginPath(); ctx.rect(hx - 4, hy - 4, 8, 8); ctx.fill(); ctx.stroke(); }
    }
  }

  function handles(box: BoundingBox): [number, number][] {
    const a = imageToScreen(box.x, box.y, viewport), b = imageToScreen(box.x + box.width, box.y + box.height, viewport);
    return [[a.x, a.y], [(a.x + b.x) / 2, a.y], [b.x, a.y], [b.x, (a.y + b.y) / 2], [b.x, b.y], [(a.x + b.x) / 2, b.y], [a.x, b.y], [a.x, (a.y + b.y) / 2]];
  }

  function point(event: PointerEvent) {
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  function selectedHandle(x: number, y: number) {
    const box = boxes.find((b) => b.id === selectedId); if (!box) return null;
    const names = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
    const index = handles(box).findIndex(([hx, hy]) => Math.abs(x - hx) <= 8 && Math.abs(y - hy) <= 8);
    return index >= 0 ? names[index] : null;
  }

  function hitBox(x: number, y: number) {
    const p = screenToImage(x, y, viewport);
    return [...boxes].reverse().find((b) => p.x >= b.x && p.x <= b.x + b.width && p.y >= b.y && p.y <= b.y + b.height);
  }

  function pointerDown(event: PointerEvent) {
    canvas.setPointerCapture(event.pointerId);
    const p = point(event), before = boxes.map((b) => ({ ...b }));
    if (spaceDown || event.button === 1) {
      action = { type: 'pan', startX: p.x, startY: p.y, before, startViewport: { ...viewport } }; return;
    }
    if (readOnly) { dispatch('select', hitBox(p.x, p.y)?.id ?? null); return; }
    const handle = selectedHandle(p.x, p.y);
    if (handle) {
      const box = boxes.find((b) => b.id === selectedId)!;
      action = { type: 'resize', startX: p.x, startY: p.y, before, box: { ...box }, handle }; return;
    }
    const hit = hitBox(p.x, p.y);
    if (hit) {
      dispatch('select', hit.id);
      action = { type: 'move', startX: p.x, startY: p.y, before, box: { ...hit } }; return;
    }
    const ip = screenToImage(p.x, p.y, viewport);
    if (ip.x < 0 || ip.y < 0 || ip.x > imageInfo.width || ip.y > imageInfo.height) { dispatch('select', null); return; }
    const box = { id: crypto.randomUUID(), classId: currentClass, x: ip.x, y: ip.y, width: 0, height: 0 };
    dispatch('select', box.id);
    action = { type: 'create', startX: p.x, startY: p.y, before, box };
    dispatch('change', [...boxes, box]);
  }

  function pointerMove(event: PointerEvent) {
    if (!action) return;
    const p = point(event);
    if (action.type === 'pan') {
      viewport = { ...viewport, offsetX: action.startViewport!.offsetX + p.x - action.startX, offsetY: action.startViewport!.offsetY + p.y - action.startY };
      draw(); return;
    }
    const dx = (p.x - action.startX) / viewport.scale, dy = (p.y - action.startY) / viewport.scale;
    let next: BoundingBox;
    if (action.type === 'create') {
      const origin = action.box!;
      const x2 = clamp(origin.x + dx, 0, imageInfo.width), y2 = clamp(origin.y + dy, 0, imageInfo.height);
      next = { ...origin, x: Math.min(origin.x, x2), y: Math.min(origin.y, y2), width: Math.abs(x2 - origin.x), height: Math.abs(y2 - origin.y) };
    } else if (action.type === 'move') {
      const box = action.box!;
      next = { ...box, x: clamp(box.x + dx, 0, imageInfo.width - box.width), y: clamp(box.y + dy, 0, imageInfo.height - box.height) };
    } else {
      const box = action.box!, handle = action.handle!;
      let left = box.x, top = box.y, right = box.x + box.width, bottom = box.y + box.height;
      if (handle.includes('w')) left = clamp(box.x + dx, 0, right - 2);
      if (handle.includes('e')) right = clamp(box.x + box.width + dx, left + 2, imageInfo.width);
      if (handle.includes('n')) top = clamp(box.y + dy, 0, bottom - 2);
      if (handle.includes('s')) bottom = clamp(box.y + box.height + dy, top + 2, imageInfo.height);
      next = { ...box, x: left, y: top, width: right - left, height: bottom - top };
    }
    dispatch('change', boxes.map((b) => b.id === next.id ? next : b));
  }

  function pointerUp() {
    if (!action) return;
    if (action.type !== 'pan') {
      let finalBoxes = boxes;
      if (action.type === 'create') finalBoxes = boxes.filter((b) => b.id !== action!.box!.id || (b.width >= 3 && b.height >= 3));
      dispatch('change', finalBoxes);
      dispatch('commit', { before: action.before, boxes: finalBoxes });
    }
    action = null;
  }

  function wheel(event: WheelEvent) {
    event.preventDefault();
    const p = { x: event.offsetX, y: event.offsetY };
    const before = screenToImage(p.x, p.y, viewport);
    const scale = clamp(viewport.scale * Math.exp(-event.deltaY * 0.0012), 0.04, 20);
    viewport = { scale, offsetX: p.x - before.x * scale, offsetY: p.y - before.y * scale };
    dispatch('viewport', Math.round(scale * 100)); draw();
  }

  function keyDown(event: KeyboardEvent) { if (event.code === 'Space') spaceDown = true; }
  function keyUp(event: KeyboardEvent) { if (event.code === 'Space') spaceDown = false; }

  onMount(() => {
    const observer = new ResizeObserver(resize); observer.observe(host); resize();
    window.addEventListener('keydown', keyDown); window.addEventListener('keyup', keyUp);
    return () => { observer.disconnect(); window.removeEventListener('keydown', keyDown); window.removeEventListener('keyup', keyUp); };
  });
</script>

<div class:grabbing={action?.type === 'pan'} class:space={spaceDown} class="canvas-host" bind:this={host}>
  <canvas bind:this={canvas} on:pointerdown={pointerDown} on:pointermove={pointerMove} on:pointerup={pointerUp} on:pointercancel={pointerUp} on:wheel={wheel}></canvas>
</div>

<style>
  .canvas-host{position:absolute;inset:0;overflow:hidden;background:#111419;cursor:crosshair;touch-action:none}
  canvas{display:block;width:100%;height:100%}.space{cursor:grab}.grabbing{cursor:grabbing}
</style>
