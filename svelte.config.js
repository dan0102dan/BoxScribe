import adapter from '@sveltejs/adapter-static';

export default {
  kit: {
    adapter: adapter({ fallback: '404.html' }),
    paths: { base: process.env.GITHUB_ACTIONS ? process.env.BASE_PATH || '' : '' },
    prerender: { entries: ['*'] }
  }
};
