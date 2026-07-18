<script lang="ts">
  export let name: 'logo' | 'folder' | 'save' | 'undo' | 'redo' | 'fit' | 'focus' | 'eye' | 'trash' | 'chevron' | 'search' | 'image' | 'check' | 'warning';
  export let size = 18;
</script>

<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  {#if name === 'logo'}<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M8 8h8v8H8z"/><path d="M3 9h3M18 15h3"/>
  {:else if name === 'folder'}<path d="M3 6.5h7l2 2h9v10H3z"/>
  {:else if name === 'save'}<path d="M5 3h12l3 3v15H4V3z"/><path d="M8 3v6h8V3M8 21v-7h8v7"/>
  {:else if name === 'undo'}<path d="M9 7 4 12l5 5"/><path d="M5 12h8a6 6 0 0 1 6 6"/>
  {:else if name === 'redo'}<path d="m15 7 5 5-5 5"/><path d="M19 12h-8a6 6 0 0 0-6 6"/>
  {:else if name === 'fit'}<path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5"/>
  {:else if name === 'focus'}<path d="M9 4H4v5M15 4h5v5M9 20H4v-5M15 20h5v-5"/><rect x="8" y="8" width="8" height="8" rx="1"/>
  {:else if name === 'eye'}<path d="M2 12s4-6 10-6 10 6 10 6-4 6-10 6S2 12 2 12Z"/><circle cx="12" cy="12" r="2.5"/>
  {:else if name === 'trash'}<path d="M4 7h16M9 7V4h6v3M7 7l1 14h8l1-14M10 11v6M14 11v6"/>
  {:else if name === 'chevron'}<path d="m9 18 6-6-6-6"/>
  {:else if name === 'search'}<circle cx="11" cy="11" r="7"/><path d="m16 16 5 5"/>
  {:else if name === 'image'}<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m4 17 5-5 4 4 2-2 5 5"/>
  {:else if name === 'check'}<path d="m5 12 4 4L19 6"/>
  {:else if name === 'warning'}<path d="M12 3 2 21h20L12 3Z"/><path d="M12 9v5M12 18h.01"/>
  {/if}
</svg>
