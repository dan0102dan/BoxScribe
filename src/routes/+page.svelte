<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { base } from '$app/paths';
  import JSZip from 'jszip';
  import AnnotationCanvas from '$lib/components/AnnotationCanvas.svelte';
  import Icon from '$lib/components/Icon.svelte';
  import { BoxHistory } from '$lib/annotation/history';
  import { serializeYolo } from '$lib/annotation/yolo';
  import { shortcuts } from '$lib/config/shortcuts';
  import type { BoundingBox, ProjectState } from '$lib/annotation/types';
  import { boxesByImage, project as generatedProject } from '$lib/generated/dataset';

  let project: ProjectState = generatedProject;
  const runtimeDataset = import.meta.env.DEV;
  let currentId: string | null = project?.lastImageId ?? project?.images[0]?.id ?? null;
  let boxes: BoundingBox[] = [];
  let selectedId: string | null = null;
  let focusedId: string | null = null;
  let currentClass = 0;
  let dirty = false;
  let saving = false;
  let saveError = '';
  let savedAt = '';
  let exporting = false;
  let togglingExcludedId: string | null = null;
  let loadingFrame: { id: string; name: string } | null = null;
  let frameRequestSequence = 0;
  let search = '';
  let filter: 'all' | 'annotated' | 'unannotated' | 'empty' | 'excluded' = 'all';
  let classFilters: number[] = [];
  let filteringClasses = false;
  let showLabels = true;
  let zoom = 100;
  let canvas: AnnotationCanvas;
  let autosaveTimer: ReturnType<typeof setTimeout>;
  let searchTimer: ReturnType<typeof setTimeout>;
  let imageList: HTMLDivElement;
  let revealedId: string | null = null;
  const frameCache = new Map<string, Promise<{ boxes: BoundingBox[]; image: typeof project.images[number]; saved: boolean }>>();
  const history = new BoxHistory();

  $: currentImage = project?.images.find((image) => image.id === currentId) ?? null;
  $: filteredImages = (project?.images ?? []).filter((image) => {
    if (image.id === currentId) return true;
    const matchesSearch = image.name.toLowerCase().includes(search.toLowerCase());
    const matchesFilter = filter === 'all' || (filter === 'excluded' && image.excluded) || (filter === 'annotated' && !image.excluded && image.annotated && !image.empty) || (filter === 'unannotated' && !image.excluded && !image.annotated) || (filter === 'empty' && !image.excluded && image.empty);
    const imageBoxes = boxesByImage[image.id] ?? [];
    const matchesClass = runtimeDataset || classFilters.every((classId) => imageBoxes.some((box) => box.classId === classId));
    return matchesSearch && matchesFilter && matchesClass;
  });
  $: selectedBox = boxes.find((box) => box.id === selectedId) ?? null;
  $: selectedBoxNumber = selectedBox ? boxes.findIndex((box) => box.id === selectedBox.id) + 1 : 0;
  $: totalImages = project.totalImages ?? project.images.length;
  $: progressTotal = project.activeImages ?? totalImages;
  $: annotatedCount = project.annotatedCount ?? project.images.filter((image) => image.annotated).length;
  $: progress = progressTotal ? Math.round(annotatedCount / progressTotal * 100) : 0;
  $: if (currentId && imageList && currentId !== revealedId) revealCurrentImage(currentId);

  async function revealCurrentImage(id: string) {
    revealedId = id;
    await tick();
    const active = [...imageList.querySelectorAll<HTMLButtonElement>('[data-image-id]')].find((button) => button.dataset.imageId === id);
    active?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  const formatCount = (value: number) => new Intl.NumberFormat('ru-RU').format(value);

  function runtimeScope() {
    return { query: search, status: filter === 'excluded' ? 'excluded' : 'active', classIds: classFilters };
  }

  function runtimeParams(extra: Record<string, string | number> = {}) {
    const scope = runtimeScope();
    const params = new URLSearchParams({ query: scope.query, status: scope.status, ...Object.fromEntries(Object.entries(extra).map(([key, value]) => [key, String(value)])) });
    if (scope.classIds.length) params.set('classIds', scope.classIds.join(','));
    return params;
  }

  async function loadRuntimeProject(query = '', preferredImage: typeof project.images[number] | null = null) {
    saveError = '';
    try {
      const response = await fetch(`/__boxscribe/project?${runtimeParams({ limit: 200, query })}`);
      const body = await response.json();
      if (!response.ok) throw new Error(body.message);
      project = body;
      currentId = null;
      if (preferredImage && !project.images.some((image) => image.id === preferredImage.id)) {
        project = { ...project, images: [...project.images, preferredImage].sort((a, b) => (a.index ?? 0) - (b.index ?? 0)) };
      }
      const target = preferredImage ?? body.images[0] ?? null;
      if (target) await openImage(target.id);
    } catch (error) { saveError = error instanceof Error ? error.message : 'Не удалось открыть датасет'; }
  }

  function searchRuntime() {
    if (!runtimeDataset) return;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => loadRuntimeProject(search), 250);
  }

  async function setStatusFilter(value: typeof filter) {
    const changedServerScope = runtimeDataset && (filter === 'excluded' || value === 'excluded');
    filter = value;
    if (changedServerScope) await loadRuntimeProject(search);
  }

  function scrollStatuses(event: WheelEvent) {
    const target = event.currentTarget as HTMLDivElement;
    if (target.scrollWidth <= target.clientWidth || Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return;
    event.preventDefault();
    target.scrollLeft += event.deltaY;
  }

  async function setClassFilter(classId: number | null) {
    classFilters = classId === null ? [] : classFilters.includes(classId) ? classFilters.filter((value) => value !== classId) : [...classFilters, classId];
    if (classFilters.length) filter = 'all';
    if (runtimeDataset) {
      filteringClasses = true;
      try { await loadRuntimeProject(search); }
      finally { filteringClasses = false; }
    }
  }

  function frameUrl(image: typeof project.images[number]) {
    return runtimeDataset ? `/__boxscribe/image?id=${encodeURIComponent(image.id)}` : `${base}/${image.assetPath}`;
  }

  function preloadPhoto(url: string) {
    return new Promise<void>((resolve, reject) => {
      const image = new Image(); image.onload = () => resolve(); image.onerror = () => reject(new Error('Не удалось загрузить изображение')); image.src = url;
    });
  }

  function prepareRuntimeFrame(image: typeof project.images[number]) {
    const cached = frameCache.get(image.id); if (cached) return cached;
    const pending = Promise.all([
      fetch(`/__boxscribe/annotations?id=${encodeURIComponent(image.id)}`).then(async (response) => {
        const body = await response.json(); if (!response.ok) throw new Error(body.message); return body;
      }),
      preloadPhoto(frameUrl(image))
    ]).then(([body]) => body);
    frameCache.set(image.id, pending);
    if (frameCache.size > 7) frameCache.delete(frameCache.keys().next().value!);
    return pending;
  }

  async function preloadNeighbor(current: typeof project.images[number], direction: number) {
    if (!runtimeDataset) return;
    const response = await fetch(`/__boxscribe/neighbor?${runtimeParams({ id: current.id, direction })}`);
    if (!response.ok) return;
    const image: typeof project.images[number] = await response.json();
    prepareRuntimeFrame(image!).catch(() => frameCache.delete(image!.id));
  }

  async function loadAnnotations() {
    if (!currentId) return;
    saveError = '';
    try {
      if (runtimeDataset) {
        const target = project.images.find((image) => image.id === currentId);
        if (!target) return;
        const body = await prepareRuntimeFrame(target);
        boxes = body.boxes;
        project = { ...project, images: project.images.map((image) => image.id === currentId ? body.image : image) };
        savedAt = body.saved ? 'Из YOLO TXT' : '';
      } else {
        const stored = localStorage.getItem(`boxscribe:boxes:${currentId}`);
        boxes = stored ? JSON.parse(stored) : (boxesByImage[currentId] ?? []).map((box) => ({ ...box, id: crypto.randomUUID() }));
        savedAt = stored ? 'Локальная версия' : 'Из data.yaml';
      }
      localStorage.setItem('boxscribe:last-image', currentId);
      dirty = false; selectedId = null; history.reset();
    } catch (error) { saveError = error instanceof Error ? error.message : 'Ошибка загрузки'; }
  }

  async function save() {
    if (!project || !currentId || saving) return true;
    if (currentImage?.excluded) return true;
    clearTimeout(autosaveTimer); saving = true; saveError = '';
    try {
      const item = project.images.find((image) => image.id === currentId);
      const wasAnnotated = item?.annotated ?? false;
      if (runtimeDataset) {
        const response = await fetch(`/__boxscribe/annotations?id=${encodeURIComponent(currentId)}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ boxes }) });
        const body = await response.json(); if (!response.ok) throw new Error(body.message);
        frameCache.delete(currentId);
      } else localStorage.setItem(`boxscribe:boxes:${currentId}`, JSON.stringify(boxes));
      if (item) { item.annotated = true; item.empty = boxes.length === 0; item.boxCount = boxes.length; project = { ...project, annotatedCount: wasAnnotated || item.excluded ? project.annotatedCount : (project.annotatedCount ?? annotatedCount) + 1, images: [...project.images] }; }
      dirty = false; savedAt = new Date().toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' }); return true;
    } catch (error) { saveError = error instanceof Error ? error.message : 'Разметка не сохранена'; return false; }
    finally { saving = false; }
  }

  function markDirty() {
    dirty = true; savedAt = '';
    clearTimeout(autosaveTimer); autosaveTimer = setTimeout(save, 1200);
  }

  function updateBoxes(next: BoundingBox[]) { boxes = next; markDirty(); }
  function commit(event: CustomEvent<{ before: BoundingBox[]; boxes: BoundingBox[] }>) {
    if (JSON.stringify(event.detail.before) !== JSON.stringify(event.detail.boxes)) history.push(event.detail.before);
  }

  async function openImage(id: string) {
    if (id === currentId && !loadingFrame) return;
    const request = ++frameRequestSequence;
    const target = project.images.find((image) => image.id === id);
    if (!target) { loadingFrame = null; return; }
    loadingFrame = { id, name: target.name };
    let awaitingCanvas = false;
    try {
      if (dirty && !await save()) return;
      if (request !== frameRequestSequence) return;
      if (runtimeDataset) {
        const body = await prepareRuntimeFrame(target);
        if (request !== frameRequestSequence) return;
        awaitingCanvas = true;
        currentId = id; boxes = body.boxes; selectedId = null; dirty = false; history.reset(); savedAt = body.saved ? 'Из YOLO TXT' : '';
        project = { ...project, images: project.images.map((image) => image.id === id ? body.image : image) };
        localStorage.setItem('boxscribe:last-image', id);
        void preloadNeighbor(target, -1); void preloadNeighbor(target, 1);
      } else {
        awaitingCanvas = true;
        currentId = id;
        await loadAnnotations();
      }
    } catch (error) {
      if (request === frameRequestSequence) saveError = error instanceof Error ? error.message : 'Ошибка загрузки';
    } finally {
      if (request === frameRequestSequence && !awaitingCanvas) loadingFrame = null;
    }
  }

  function finishFrameLoading(url: string, failed = false) {
    if (!currentImage || !loadingFrame || loadingFrame.id !== currentImage.id || url !== frameUrl(currentImage)) return;
    loadingFrame = null;
    if (failed) saveError = 'Не удалось отобразить изображение';
  }

  async function openIndex(targetIndex: number) {
    if (targetIndex < 0 || targetIndex >= totalImages) return;
    let next = project.images.find((image) => image.index === targetIndex);
    if (!next && runtimeDataset) {
      const response = await fetch(`/__boxscribe/item?index=${targetIndex}`);
      if (response.ok) { next = await response.json(); project = { ...project, images: [...project.images, next!].sort((a, b) => (a.index ?? 0) - (b.index ?? 0)) }; }
    } else if (!next) next = project.images[targetIndex];
    if (next) await openImage(next.id);
  }

  async function navigate(direction: number) {
    if (!project || !currentId) return;
    const current = project.images.find((image) => image.id === currentId);
    if (runtimeDataset && current) {
      const response = await fetch(`/__boxscribe/neighbor?${runtimeParams({ id: current.id, direction })}`);
      if (!response.ok) return;
      const next = await response.json();
      if (!project.images.some((image) => image.id === next.id)) project = { ...project, images: [...project.images, next].sort((a, b) => (a.index ?? 0) - (b.index ?? 0)) };
      await openImage(next.id); return;
    }
    await openIndex((current?.index ?? project.images.findIndex((image) => image.id === currentId)) + direction);
  }

  async function jumpToFrame(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const requested = Number.parseInt(input.value, 10);
    const current = currentImage ? (currentImage.index ?? project.images.findIndex((image) => image.id === currentId)) + 1 : 1;
    if (!Number.isInteger(requested) || requested < 1 || requested > totalImages) { input.value = String(current); return; }
    search = ''; filter = 'all';
    await openIndex(requested - 1);
  }

  function frameInputKey(event: KeyboardEvent) {
    if (event.key === 'Enter') (event.currentTarget as HTMLInputElement).blur();
    if (event.key === 'Escape') { const input = event.currentTarget as HTMLInputElement; input.value = String(currentImage ? (currentImage.index ?? 0) + 1 : 1); input.blur(); }
  }

  function placeFrameCaretAtEnd(event: FocusEvent | PointerEvent) {
    if (event instanceof PointerEvent) event.preventDefault();
    const input = event.currentTarget as HTMLInputElement;
    input.focus({ preventScroll: true });
    requestAnimationFrame(() => {
      const end = input.value.length;
      input.setSelectionRange(end, end);
    });
  }

  async function nextUnannotated() {
    if (!project) return;
    const start = Math.max(0, project.images.findIndex((image) => image.id === currentId));
    const next = [...project.images.slice(start + 1), ...project.images.slice(0, start)].find((image) => !image.annotated && !image.excluded);
    if (next) await openImage(next.id);
  }

  async function toggleExcluded(image: typeof project.images[number]) {
    if (!runtimeDataset || togglingExcludedId) return;
    if (image.id === currentId && dirty && !await save()) return;
    togglingExcludedId = image.id; saveError = '';
    try {
      const response = await fetch(`/__boxscribe/exclude?id=${encodeURIComponent(image.id)}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ excluded: !image.excluded, currentId, ...runtimeScope() }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.message);
      frameCache.clear();
      await loadRuntimeProject(search, body.nextImage ?? null);
    } catch (error) { saveError = error instanceof Error ? error.message : 'Не удалось изменить статус кадра'; }
    finally { togglingExcludedId = null; }
  }

  function removeSelected() {
    if (!selectedId || currentImage?.excluded) return;
    history.push(boxes); boxes = boxes.filter((box) => box.id !== selectedId); selectedId = null; focusedId = null; markDirty();
  }

  function changeSelectedClass(classId: number) {
    currentClass = classId;
    if (!selectedId || currentImage?.excluded) return;
    if (boxes.find((box) => box.id === selectedId)?.classId === classId) return;
    history.push(boxes); boxes = boxes.map((box) => box.id === selectedId ? { ...box, classId } : box); markDirty();
  }

  function selectBox(id: string | null) {
    if (id !== selectedId) focusedId = null;
    selectedId = id;
    const box = boxes.find((item) => item.id === id);
    if (box) currentClass = box.classId;
  }

  async function focusCurrent() {
    if (!selectedId) return;
    focusedId = selectedId;
    await tick();
    canvas?.focusSelected();
  }

  async function browseBoxes(direction: 1 | -1, advance = false) {
    if (!boxes.length) return;
    const currentIndex = boxes.findIndex((box) => box.id === selectedId);
    const startIndex = direction > 0 ? 0 : boxes.length - 1;
    const targetIndex = currentIndex < 0
      ? startIndex
      : advance || focusedId === selectedId
        ? (currentIndex + direction + boxes.length) % boxes.length
        : currentIndex;
    selectBox(boxes[targetIndex].id);
    await focusCurrent();
  }

  function undo() { if (currentImage?.excluded) return; const previous = history.undo(boxes); if (previous) { boxes = previous; selectedId = null; markDirty(); } }
  function redo() { if (currentImage?.excluded) return; const next = history.redo(boxes); if (next) { boxes = next; selectedId = null; markDirty(); } }

  async function downloadBundle() {
    if (!currentImage) return;
    exporting = true; saveError = '';
    try {
      if (!currentImage.excluded && !await save()) throw new Error('Сначала сохраните изменения');
      const imageResponse = await fetch(runtimeDataset ? `/__boxscribe/image?id=${encodeURIComponent(currentImage.id)}` : `${base}/${currentImage.assetPath}`);
      if (!imageResponse.ok) throw new Error('Не удалось добавить кадр в ZIP');
      const stem = currentImage.name.replace(/\.[^.]+$/, '');
      const label = boxes.length ? `${serializeYolo(boxes, currentImage.width, currentImage.height)}\n` : '';
      const zip = new JSZip();
      zip.file(currentImage.name, await imageResponse.blob());
      zip.file(`${stem}.txt`, label);
      const archive = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(archive); link.download = `${stem}.zip`; link.click();
      URL.revokeObjectURL(link.href);
    } catch (error) { saveError = error instanceof Error ? error.message : 'Не удалось собрать ZIP'; }
    finally { exporting = false; }
  }

  function keyHandler(event: KeyboardEvent) {
    if ((event.target as HTMLElement).matches('input, textarea, select')) return;
    const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
    if ((event.ctrlKey || event.metaKey) && key === 'Backspace') { event.preventDefault(); if (currentImage) toggleExcluded(currentImage); return; }
    if ((event.ctrlKey || event.metaKey) && key === 'z') { event.preventDefault(); event.shiftKey ? redo() : undo(); return; }
    if ((event.ctrlKey || event.metaKey) && key === 'y') { event.preventDefault(); redo(); return; }
    if (event.code === 'Space') { event.preventDefault(); return; }
    if (shortcuts.previous.includes(key as never)) navigate(-1);
    else if (shortcuts.next.includes(key as never)) navigate(1);
    else if (shortcuts.save.includes(key as never)) { event.preventDefault(); save(); }
    else if (shortcuts.fit.includes(key as never)) canvas?.fit();
    else if (shortcuts.focus.includes(key as never)) { event.preventDefault(); browseBoxes(event.shiftKey ? -1 : 1); }
    else if (key === 'Delete' || key === 'Backspace') removeSelected();
    else if (/^[1-9]$/.test(key)) changeSelectedClass(Number(key) - 1);
    else if (shortcuts.previousClass.includes(key as never)) changeSelectedClass((currentClass - 1 + (project?.classes.length ?? 1)) % (project?.classes.length ?? 1));
    else if (shortcuts.nextClass.includes(key as never)) changeSelectedClass((currentClass + 1) % (project?.classes.length ?? 1));
  }

  onMount(() => {
    window.addEventListener('keydown', keyHandler);
    if (runtimeDataset) loadRuntimeProject();
    else {
      const remembered = localStorage.getItem('boxscribe:last-image');
      if (remembered && project.images.some((image) => image.id === remembered)) currentId = remembered;
      if (currentId) loadAnnotations();
    }
    const beforeUnload = (event: BeforeUnloadEvent) => { if (dirty) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', beforeUnload);
    return () => { window.removeEventListener('keydown', keyHandler); window.removeEventListener('beforeunload', beforeUnload); clearTimeout(autosaveTimer); clearTimeout(searchTimer); };
  });
</script>

<svelte:head><title>{project ? `${currentImage?.name ?? ''} — BoxScribe` : 'BoxScribe — быстрый разметчик'}</title><meta name="description" content="Легковесный локальный редактор bounding box" /></svelte:head>

<main class="app-shell">
    <header class="topbar">
      <div class:complete={progress === 100} class="top-progress">
        <div class="progress-head"><span>Размечено</span><strong title={`${formatCount(annotatedCount)} из ${formatCount(progressTotal)}`}>{formatCount(annotatedCount)}</strong><b>{progress}%</b></div>
        <div class="progress-track"><i style={`width:${progress}%`}></i></div>
      </div>
      {#if currentImage}<div class="top-image-caption"><Icon name="image" size={15}/><span>{currentImage.name}</span><span class="resolution"><i class="frame-edge left"></i><small>{currentImage.width} × {currentImage.height}</small><i class="frame-edge right"></i></span></div>{/if}
      <div class="top-actions">
        <span class:danger={saveError} class="save-state">{#if saveError}<Icon name="warning" size={14}/>{saveError}{:else if saving}<i class="spinner"></i>Сохранение…{:else if dirty}<i class="dirty-dot"></i>Не сохранено{:else}<Icon name="check" size={14}/>{savedAt ? `Сохранено · ${savedAt}` : 'Синхронизировано'}{/if}</span>
        <button class="icon-btn" on:click={undo} disabled={Boolean(currentImage?.excluded)} title="Отменить (Ctrl+Z)"><Icon name="undo"/></button><button class="icon-btn" on:click={redo} disabled={Boolean(currentImage?.excluded)} title="Повторить (Ctrl+Y)"><Icon name="redo"/></button>
        <button class="icon-btn export-btn" on:click={downloadBundle} disabled={exporting} title="Скачать кадр и YOLO TXT в ZIP">{exporting ? 'ZIP…' : 'ZIP ↓'}</button>
        <button class="save-btn" on:click={save} disabled={Boolean(currentImage?.excluded)}><Icon name="save"/>Сохранить <kbd>S</kbd></button>
      </div>
    </header>
    <aside class="sidebar">
      <div class="search"><Icon name="search" size={16}/><input bind:value={search} on:input={searchRuntime} placeholder="Поиск по имени" /></div>
      <div class="filter-block object-filter">
        <div class="filter-title"><span>{filteringClasses ? 'Индексация…' : 'Объекты на кадре'}</span><small>{classFilters.length ? `AND · ${classFilters.length}` : 'Любой класс'}</small></div>
        <div class:loading={filteringClasses} class="class-filters"><button disabled={filteringClasses} class:active={classFilters.length === 0} aria-pressed={classFilters.length === 0} on:click={() => setClassFilter(null)}>Любой</button>{#each project.classes as className, index}<button disabled={filteringClasses} class:active={classFilters.includes(index)} aria-pressed={classFilters.includes(index)} style={`--filter-color:var(--c${index % 9})`} on:click={() => setClassFilter(index)}><i></i>{className}</button>{/each}</div>
      </div>
      {#if classFilters.length}
        <div class="status-locked"><span>Статус</span><b><i></i>С разметкой</b></div>
      {:else}
        <div class="status-filter"><span>Статус</span><div class="filters" on:wheel={scrollStatuses}><button class:active={filter === 'all'} on:click={() => setStatusFilter('all')}>Все</button><button class:active={filter === 'unannotated'} on:click={() => setStatusFilter('unannotated')}>Новые</button><button class:active={filter === 'annotated'} on:click={() => setStatusFilter('annotated')}>Готово</button><button class:active={filter === 'empty'} on:click={() => setStatusFilter('empty')}>Пустые</button><button class:active={filter === 'excluded'} on:click={() => setStatusFilter('excluded')}>Исключённые</button></div></div>
      {/if}
      <div class="image-list" bind:this={imageList}>
        {#each filteredImages as image, index}
          <div data-image-id={image.id} class:active={image.id === currentId} class:excluded={image.excluded} class="image-row">
            <button class="image-open" on:click={() => openImage(image.id)}><span class:done={image.boxCount > 0} class:empty={image.boxCount === 0} class:unknown={image.boxCount < 0} class="status">{image.boxCount < 0 ? '?' : image.boxCount}</span><span class="file"><b>{image.name}</b><small>{image.excluded ? 'Исключён из датасета' : image.width ? `${image.width}×${image.height}` : 'Данные при открытии'}{!image.excluded && image.boxCount ? ` · ${image.boxCount} bbox` : ''}</small></span></button>
            {#if runtimeDataset}<button class:active={image.excluded} class="exclude-toggle" on:click={() => toggleExcluded(image)} disabled={togglingExcludedId !== null} title={image.excluded ? 'Вернуть кадр (Ctrl/Cmd+Backspace)' : 'Исключить кадр (Ctrl/Cmd+Backspace)'}><Icon name={image.excluded ? 'restore' : 'trash'} size={14}/></button>{/if}<span class="number">{String((image.index ?? project!.images.indexOf(image)) + 1).padStart(3, '0')}</span>
          </div>
        {/each}
        {#if !filteredImages.length}<div class="no-results">Ничего не найдено</div>{/if}
      </div>
      <button class="next-new" on:click={nextUnannotated}>Следующий неразмеченный <Icon name="chevron" size={16}/></button>
    </aside>
    <section class="workspace">
      {#if currentImage}
        {#key currentImage.id}<AnnotationCanvas bind:this={canvas} imageUrl={frameUrl(currentImage)} imageInfo={currentImage} {boxes} {selectedId} {currentClass} classes={project.classes} {showLabels} readOnly={Boolean(currentImage.excluded)} on:change={(e) => updateBoxes(e.detail)} on:commit={commit} on:select={(e) => selectBox(e.detail)} on:viewport={(e) => zoom = e.detail} on:ready={(e) => finishFrameLoading(e.detail)} on:loaderror={(e) => finishFrameLoading(e.detail, true)}/>{/key}
        <div class="canvas-tools"><button on:click={() => canvas.fit()} title="Показать весь кадр (F)"><Icon name="fit"/></button><button class:active={showLabels} on:click={() => showLabels = !showLabels} title="Подписи"><Icon name="eye"/></button><span>{zoom}%</span></div>
        <div class="nav-controls"><button on:click={() => navigate(-1)} disabled={(currentImage.index ?? 0) === 0}><span class="arrow">←</span><kbd>A</kbd></button><span class="counter"><input type="text" inputmode="numeric" pattern="[0-9]*" value={(currentImage.index ?? project.images.findIndex((i) => i.id === currentId)) + 1} aria-label="Перейти к номеру кадра" on:focus={placeFrameCaretAtEnd} on:pointerdown={placeFrameCaretAtEnd} on:change={jumpToFrame} on:keydown={frameInputKey}/><small>/ {totalImages}</small></span><button on:click={() => navigate(1)} disabled={(currentImage.index ?? project.images.findIndex((i) => i.id === currentId)) >= totalImages - 1}><kbd>D</kbd><span class="arrow">→</span></button></div>
      {/if}
      {#if loadingFrame}<div class="frame-loading" role="status" aria-live="polite"><div><i class="spinner"></i><span>Загрузка кадра</span><small>{loadingFrame.name}</small></div></div>{/if}
    </section>
    <aside class="inspector">
      <div class="panel-head class-mode"><span>{selectedBox ? 'Класс выбранного bbox' : 'Класс нового bbox'}</span><small>{selectedBox ? 'EDIT' : 'DRAW'}</small></div>
      <div class="class-list">
        {#each project.classes as className, index}<button class:active={currentClass === index} style={`--class-color:var(--c${index % 9})`} on:click={() => changeSelectedClass(index)}><i></i><span><b>{className}</b><small>{selectedBox ? 'Применить к выбранному' : 'Для следующего bbox'}</small></span>{#if index < 9}<kbd>{index + 1}</kbd>{/if}</button>{/each}
      </div>
      <div class="panel-head boxes-head"><span>Объекты</span><small>{boxes.length}</small></div>
      <div class="box-list">
        {#each boxes as box, index}<button class:active={box.id === selectedId} on:click={() => selectBox(box.id)}><i style={`--class-color:var(--c${box.classId % 9})`}></i><span><b>{project.classes[box.classId] ?? `Класс ${box.classId}`}</b><small>#{index + 1} · {Math.round(box.width)}×{Math.round(box.height)}</small></span></button>{/each}
        {#if !boxes.length}<div class="empty-boxes"><span>＋</span><b>Нарисуйте первый bbox</b><small>Протяните мышью по объекту</small></div>{/if}
      </div>
      {#if selectedBox}<div class="selection-card"><div><span>Объект <b>{selectedBoxNumber} / {boxes.length}</b></span><span class="selection-actions"><button class="box-previous" on:click={() => browseBoxes(-1, true)} title="Предыдущий объект (Shift+B)"><Icon name="chevron" size={15}/></button><button class="focus-selected" on:click={focusCurrent} title="Приблизить выбранный bbox (B)"><Icon name="focus" size={16}/></button><button on:click={() => browseBoxes(1, true)} title="Следующий объект (B)"><Icon name="chevron" size={15}/></button><button class="remove-selected" on:click={removeSelected} title="Удалить"><Icon name="trash" size={16}/></button></span></div><label><span>Класс</span><select value={selectedBox.classId} on:change={(event) => changeSelectedClass(Number(event.currentTarget.value))}>{#each project.classes as className, index}<option value={index}>{className}</option>{/each}</select></label><code>x {Math.round(selectedBox.x)} · y {Math.round(selectedBox.y)}<br/>w {Math.round(selectedBox.width)} · h {Math.round(selectedBox.height)}</code></div>{/if}
      <div class="hints"><span><kbd>Space</kbd> Перемещение</span><span><kbd>Scroll</kbd> Масштаб</span><span><kbd>Del</kbd> Удалить</span><span><kbd>F</kbd> Весь кадр</span></div>
    </aside>
</main>

<style>
  :global(*){box-sizing:border-box}:global(html,body){margin:0;min-width:960px;height:100%;overflow:hidden;background:#0d0f12;color:#eceff1;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}:global(button),:global(input),:global(textarea){font:inherit}
  .app-shell{--side:260px;--inspect:250px;--top:44px;--c0:#e9ff70;--c1:#ff8d5c;--c2:#70d6ff;--c3:#d7a7ff;--c4:#77e6a1;--c5:#ffd166;--c6:#ff7a9e;--c7:#b8c0ff;--c8:#f3a6ff;height:100vh;display:grid;grid-template-columns:var(--side) 1fr var(--inspect);grid-template-rows:var(--top) 1fr;background:#111419}.topbar{grid-column:1/-1;display:flex;align-items:center;border-bottom:1px solid #2b2e34;background:#12151a;z-index:3}.top-actions{margin-left:auto;height:100%;display:flex;align-items:center;gap:7px;padding:0 12px}.save-state{display:flex;align-items:center;gap:6px;color:#7f878f;font-size:10px;margin-right:10px}.save-state.danger{color:#ff8d72}.dirty-dot{width:7px;height:7px;border-radius:50%;background:#ffd166}.icon-btn{width:34px;height:34px;border:1px solid #30343b;background:#181b21;color:#9ea5ad;border-radius:7px;display:grid;place-items:center;cursor:pointer}.icon-btn.export-btn{width:auto;padding:0 9px;font:600 9px ui-monospace}.icon-btn:hover{color:#fff;border-color:#505762}.save-btn{height:34px;border:0;background:#e9ff70;color:#111318;border-radius:7px;padding:0 10px;display:flex;align-items:center;gap:8px;font-size:11px;font-weight:700;cursor:pointer}.save-btn kbd{background:#c8dc5e;padding:2px 5px;border-radius:4px}.sidebar,.inspector{min-height:0;background:#14171c}.sidebar{border-right:1px solid #2b2e34;display:flex;flex-direction:column}.progress-head{display:flex;justify-content:space-between;padding:18px 17px 10px}.progress-head span,.panel-head span{font-size:10px;text-transform:uppercase;letter-spacing:.12em;color:#757c84}.progress-head strong{font-size:12px}.progress-head>b{font:600 11px ui-monospace;color:#e9ff70}.progress-track{height:3px;background:#292d33;margin:0 17px 14px}.progress-track i{display:block;height:100%;background:#e9ff70}.search{height:34px;margin:0 12px 9px;background:#0f1216;border:1px solid #2d3138;border-radius:7px;display:flex;align-items:center;gap:8px;padding:0 9px;color:#616871}.search input{border:0;outline:0;background:transparent;color:#dce0e4;width:100%;font-size:11px}.filters{display:flex;padding:0 12px 10px;gap:4px}.filters button{border:0;background:transparent;color:#737a82;padding:5px 7px;border-radius:5px;font-size:9px;cursor:pointer}.filters button.active{background:#2b3036;color:#e9ff70}.image-list{border-top:1px solid #262a30;overflow-y:auto;flex:1}.status{width:20px;height:20px;border:1px solid #3b4148;border-radius:5px;display:grid;place-items:center;font-size:10px;flex:none}.status.done{border-color:#89a03d;color:#e9ff70;background:#e9ff7010}.status.empty{border-color:#555b63;color:#848b93}.status.unknown{border-color:#4a5159;background:#20252a;color:#8b939b;font-weight:700}.file{min-width:0;display:flex;flex-direction:column;gap:3px;flex:1}.file b{font:500 11px ui-monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.file small{font-size:9px;color:#626970}.number{font:9px ui-monospace;color:#535a62}.next-new{height:40px;border:0;border-top:1px solid #2b2e34;background:#171a1f;color:#aeb4ba;display:flex;align-items:center;justify-content:center;gap:8px;font-size:10px;cursor:pointer}.next-new:hover{color:#e9ff70}.no-results{padding:30px;text-align:center;color:#60676e;font-size:11px}.workspace{position:relative;min-width:0;min-height:0}.spinner{display:inline-block;width:12px;height:12px;border:2px solid #596069;border-top-color:#e9ff70;border-radius:50%;animation:spin .8s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}.canvas-tools{position:absolute;left:14px;top:14px;display:flex;background:#15191edb;border:1px solid #333840;border-radius:8px;overflow:hidden;backdrop-filter:blur(7px)}.canvas-tools button{width:34px;height:34px;display:grid;place-items:center;background:transparent;color:#858d95;border:0;border-right:1px solid #30343b;cursor:pointer}.canvas-tools button:hover,.canvas-tools button.active{color:#e9ff70;background:#24292f}.canvas-tools span{min-width:52px;display:grid;place-items:center;font:10px ui-monospace;color:#9299a1}.nav-controls{position:absolute;left:50%;bottom:16px;transform:translateX(-50%);height:38px;display:flex;align-items:center;background:#15191eef;border:1px solid #373c44;border-radius:9px;overflow:hidden;backdrop-filter:blur(8px)}.nav-controls button{height:100%;border:0;background:transparent;color:#c9ced3;padding:0 14px;cursor:pointer}.nav-controls button:hover{background:#252a31;color:#e9ff70}.nav-controls button:disabled{opacity:.25}.nav-controls kbd{font-size:9px;color:#747c83;border:1px solid #41474f;border-radius:3px;padding:2px 4px}.nav-controls>.counter{font:600 11px ui-monospace;border-left:1px solid #30343b;border-right:1px solid #30343b}.nav-controls small{color:#6d747c}.inspector{border-left:1px solid #2b2e34;display:flex;flex-direction:column;min-height:0}.panel-head{height:42px;display:flex;align-items:center;justify-content:space-between;padding:0 13px;border-bottom:1px solid #262a30}.panel-head small{font:10px ui-monospace;color:#646b73;background:#24282e;padding:3px 6px;border-radius:4px}.class-list{padding:7px;border-bottom:1px solid #2b2e34;max-height:255px;overflow:auto}.class-list button,.box-list button{border:0;width:100%;background:transparent;color:#afb5bb;border-radius:6px;display:flex;align-items:center;text-align:left;cursor:pointer}.class-list button{height:32px;gap:8px;padding:0 8px;font-size:11px}.class-list button:hover,.class-list button.active{background:#24292f;color:#fff}.class-list button.active{box-shadow:inset 2px 0 var(--class-color,#e9ff70)}.class-list i,.box-list i{width:8px;height:8px;background:var(--class-color);border-radius:2px;flex:none}.class-list span{flex:1}.class-list kbd{font:9px ui-monospace;color:#626970;border:1px solid #3a3f46;border-radius:4px;padding:2px 5px}.boxes-head{border-top:0}.box-list{flex:1;min-height:0;overflow:auto;padding:7px}.box-list button{padding:7px 8px;gap:9px}.box-list button:hover,.box-list button.active{background:#23282e}.box-list button span{display:flex;flex-direction:column;gap:3px;min-width:0}.box-list button b{font-size:10px;font-weight:600}.box-list button small{font:9px ui-monospace;color:#656c73}.empty-boxes{text-align:center;color:#676e76;display:flex;flex-direction:column;align-items:center;padding:36px 0;gap:6px}.empty-boxes>span{width:34px;height:34px;border:1px dashed #4a5058;border-radius:8px;display:grid;place-items:center;font-size:18px;margin-bottom:4px}.empty-boxes b{font-size:10px;color:#8d949b}.empty-boxes small{font-size:9px}.selection-card{margin:8px;border:1px solid #30353c;background:#191d22;border-radius:8px;padding:9px}.selection-card>div{display:flex;align-items:center;justify-content:space-between;color:#747b83;font-size:9px;text-transform:uppercase;letter-spacing:.1em}.selection-card button{border:0;background:transparent;color:#737a82;cursor:pointer}.selection-card button:hover{color:#ff8d72}.selection-card code{font-size:9px;color:#aeb5bc;line-height:1.7}.hints{border-top:1px solid #2b2e34;padding:10px;display:grid;grid-template-columns:1fr 1fr;gap:7px;color:#656c74;font-size:8px}.hints kbd{font:8px ui-monospace;color:#a5abb1;border:1px solid #393f46;background:#1c2025;border-radius:3px;padding:2px 4px;margin-right:3px}
  .top-progress{width:var(--side);height:100%;padding:0 13px;border-right:1px solid #2b2e34;display:flex;flex-direction:column;justify-content:center;gap:5px;flex:none}.top-progress .progress-head{display:grid;grid-template-columns:auto minmax(0,1fr) auto;align-items:baseline;gap:9px;padding:0}.top-progress .progress-head>span{font:650 8px ui-monospace;text-transform:uppercase;letter-spacing:.14em;color:#686f77;white-space:nowrap}.top-progress .progress-head>strong{min-width:0;justify-self:end;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:700 12px ui-monospace;color:#e8ebee;letter-spacing:-.03em}.top-progress .progress-head>b{padding:2px 6px;border:1px solid #3a4149;border-radius:4px;background:#1b1f24;color:#aeb5bc;font:700 9px ui-monospace}.top-progress.complete .progress-head>b{border-color:#aabd4c55;background:#e9ff700d;color:#e9ff70}.top-progress .progress-track{height:2px;margin:0;background:#292e34;border-radius:1px;overflow:hidden}.top-progress .progress-track i{display:block;height:100%;border-radius:1px;background:linear-gradient(90deg,#bcd64c,#e9ff70);box-shadow:0 0 8px #e9ff7040}.top-image-caption{height:100%;min-width:0;padding:0 16px;display:flex;align-items:center;gap:8px;color:#c2c7cc;font:10px ui-monospace}.top-image-caption>span:not(.resolution){max-width:38vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.top-image-caption .resolution{height:26px;margin-left:3px;padding:0 7px;display:inline-flex;align-items:center;gap:6px;border:1px solid #30363e;border-radius:6px;background:#181c21;color:#747c85;white-space:nowrap}.top-image-caption .resolution small{color:#8a929a;font:600 9px ui-monospace}.topbar .icon-btn,.topbar .save-btn{height:30px}.topbar .icon-btn{min-width:30px}.topbar .save-btn{padding:0 9px}.sidebar>.search{margin-top:12px}.icon-btn:disabled{opacity:.45;cursor:wait}.class-mode small{color:#e9ff70;background:#e9ff7012}.class-list button{height:44px;border:1px solid transparent;border-left-width:3px;border-radius:8px;transition:background-color .14s ease,border-color .14s ease}.class-list button:hover{border-color:#343a42}.class-list button.active{background:color-mix(in srgb,var(--class-color) 8%,#20252b);border-color:color-mix(in srgb,var(--class-color) 58%,transparent);border-left-color:var(--class-color);box-shadow:none}.class-list button>i{background:var(--class-color)}.class-list button>span{display:flex;flex-direction:column;gap:2px}.class-list button b{font-size:11px;font-weight:650}.class-list button small{font-size:8px;color:#606870}.class-list button.active small{color:color-mix(in srgb,var(--class-color) 58%,#747b83)}.selection-card label{display:flex;align-items:center;justify-content:space-between;margin:8px 0;color:#737a82;font-size:9px;text-transform:none;letter-spacing:0}.selection-card select{width:130px;border:1px solid #3a4047;border-radius:5px;background:#101318;color:#e7eaed;padding:5px 7px;font-size:10px;outline:none}.selection-card select:focus{border-color:#e9ff70}.nav-controls{display:grid;grid-template-columns:72px minmax(132px,auto) 72px}.nav-controls button{padding:0;display:flex;align-items:center;justify-content:center;gap:9px}.nav-controls>.counter{height:100%;padding:0 14px;display:flex;align-items:center;justify-content:center;gap:6px;text-align:center}.nav-controls .counter input{width:7ch;border:0;border-bottom:1px solid transparent;background:transparent;color:#f1f3f5;font:700 12px ui-monospace;text-align:right;outline:none;padding:3px 1px;-moz-appearance:textfield;appearance:textfield}.nav-controls .counter input::-webkit-inner-spin-button,.nav-controls .counter input::-webkit-outer-spin-button{-webkit-appearance:none;margin:0}.nav-controls .counter input:hover{border-bottom-color:#525a63}.nav-controls .counter input:focus{color:#111318;background:#e9ff70;border-bottom-color:#e9ff70;border-radius:3px;text-align:right}.nav-controls .arrow{width:14px;font-size:16px;line-height:1;color:#aeb5bc}.nav-controls kbd{min-width:25px;text-align:center}
  .class-list button{position:relative;height:44px;padding-left:13px;border:0;border-radius:8px;transition:background-color .14s ease}.class-list button:hover{border:0;background:#20252b}.class-list button.active{border:0;background:color-mix(in srgb,var(--class-color) 7%,#20252b);box-shadow:none}.class-list button.active::before{content:"";position:absolute;left:0;top:9px;bottom:9px;width:4px;border-radius:999px;background:var(--class-color);box-shadow:0 0 7px color-mix(in srgb,var(--class-color) 28%,transparent)}
  .top-image-caption .resolution{height:20px;margin-left:1px;padding:0;gap:5px;border:0;background:transparent}.top-image-caption .resolution small{color:#7f8790;font-size:9px;font-weight:600;letter-spacing:0}.resolution .frame-edge{position:relative;width:5px;height:13px;flex:none;opacity:.9}.resolution .frame-edge::before,.resolution .frame-edge::after{content:"";position:absolute;left:0;width:5px;height:4px}.resolution .frame-edge.left::before{top:0;border-top:1px solid #737b84;border-left:1px solid #737b84}.resolution .frame-edge.left::after{bottom:0;border-bottom:1px solid #737b84;border-left:1px solid #737b84}.resolution .frame-edge.right::before{top:0;border-top:1px solid #737b84;border-right:1px solid #737b84}.resolution .frame-edge.right::after{bottom:0;border-bottom:1px solid #737b84;border-right:1px solid #737b84}
  .class-filters{display:flex;align-items:center;gap:4px;padding:0 12px 9px;overflow-x:auto;scrollbar-width:none}.class-filters::-webkit-scrollbar{display:none}.class-filters button{height:25px;padding:0 8px;border:1px solid #30363d;border-radius:6px;background:transparent;color:#7e858d;display:flex;align-items:center;gap:5px;font-size:9px;white-space:nowrap;cursor:pointer}.class-filters button i{width:6px;height:6px;border-radius:2px;background:var(--filter-color)}.class-filters button:hover{color:#c6cbd0;background:#1d2127}.class-filters button.active{border-color:color-mix(in srgb,var(--filter-color,#e9ff70) 55%,#30363d);background:color-mix(in srgb,var(--filter-color,#e9ff70) 8%,#1d2127);color:#e5e8ea}.class-filters button:disabled{opacity:.45;cursor:wait}
  .selection-card>div>span:first-child{display:flex;align-items:center;gap:5px}.selection-card>div>span:first-child b{color:#aeb5bc;font:650 9px ui-monospace;letter-spacing:0}.selection-actions{display:flex;align-items:center;gap:2px}.selection-actions button{width:24px;height:25px;display:grid;place-items:center;border-radius:5px}.selection-actions .box-previous :global(svg){transform:rotate(180deg)}.selection-actions .focus-selected:hover,.selection-actions button:not(.remove-selected):hover{color:#e9ff70;background:#e9ff7010}.selection-actions .remove-selected{margin-left:2px}.selection-actions .remove-selected:hover{background:#ff8d7210}
  .selection-actions button{padding:0;line-height:0}.selection-actions button :global(svg){display:block;margin:auto}
  .workspace{overflow:hidden;isolation:isolate}.canvas-tools,.nav-controls{z-index:2}
  .frame-loading{position:absolute;inset:0;z-index:4;display:grid;place-items:center;background:#11141966;backdrop-filter:blur(12px) saturate(.72);animation:loading-in .14s ease-out;color:#aeb5bc}.frame-loading>div{min-width:190px;max-width:min(420px,60%);padding:14px 18px;border:1px solid #343a42;background:#15191ee8;border-radius:10px;box-shadow:0 12px 34px #0008;display:grid;grid-template-columns:20px minmax(0,1fr);align-items:center;column-gap:10px;row-gap:3px}.frame-loading .spinner{grid-row:1/3;width:17px;height:17px}.frame-loading span{font-size:11px;font-weight:650}.frame-loading small{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#68717a;font:9px ui-monospace}@keyframes loading-in{from{opacity:0;backdrop-filter:blur(0) saturate(1)}to{opacity:1;backdrop-filter:blur(12px) saturate(.72)}}
  .filter-block{padding:9px 12px 10px;border-top:1px solid #252a30;border-bottom:1px solid #252a30;background:#15191e}.filter-title{display:flex;align-items:center;justify-content:space-between;margin-bottom:7px}.filter-title>span,.status-filter>span,.status-locked>span{color:#666e76;font:650 8px ui-monospace;text-transform:uppercase;letter-spacing:.12em}.filter-title>small{color:#50575f;font:600 8px ui-monospace}.object-filter .class-filters{padding:0;gap:5px}.status-filter{padding:8px 12px 10px;display:grid;grid-template-columns:45px 1fr;align-items:center;gap:5px}.status-filter .filters{padding:0;gap:2px}.status-filter .filters button{padding:5px 6px}.status-locked{height:39px;padding:0 12px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #252a30}.status-locked>b{display:flex;align-items:center;gap:6px;color:#8d959d;font-size:9px;font-weight:600}.status-locked>b i{width:6px;height:6px;border-radius:50%;background:#77e6a1;box-shadow:0 0 0 3px #77e6a112}
  .status-filter{align-items:center}.status-filter .filters{min-width:0;overflow-x:auto;flex-wrap:nowrap;scrollbar-width:none}.status-filter .filters::-webkit-scrollbar{display:none}.status-filter .filters button{flex:none;white-space:nowrap}.image-row{position:relative;min-height:58px;border-bottom:1px solid #22262b;display:flex;align-items:center;background:transparent}.image-row:hover{background:#1a1e24}.image-row.active{background:#20252b;box-shadow:inset 3px 0 #e9ff70}.image-row.excluded:not(.active){background:#17191d}.image-row.excluded .file b{color:#848b92;text-decoration:line-through;text-decoration-color:#596067}.image-row.excluded .status{opacity:.5}.image-open{min-width:0;flex:1;align-self:stretch;padding:10px 4px 10px 11px;border:0;background:transparent;color:#cfd3d7;text-align:left;display:flex;align-items:center;gap:9px;cursor:pointer}.exclude-toggle{width:26px;height:28px;padding:0;flex:none;display:grid;place-items:center;border:0;border-radius:5px;background:transparent;color:#555d65;cursor:pointer}.exclude-toggle:hover{background:#ff8d7210;color:#ff8d72}.exclude-toggle.active{color:#ff8d72;background:#ff8d720c}.exclude-toggle.active:hover{color:#e9ff70;background:#e9ff7010}.exclude-toggle:disabled{opacity:.45;cursor:wait}.image-row .number{width:32px;padding-right:9px;text-align:right;flex:none}
  @media(max-width:1100px){.app-shell{--side:220px;--inspect:220px}}
</style>
