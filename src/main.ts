import { createApp } from 'vue';
import App from './App.vue';
import './style.css';

createApp(App).mount('#app');

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`)
      .then(async (registration) => {
        await navigator.serviceWorker.ready;
        window.dispatchEvent(new CustomEvent('offline-ready'));
        registration.addEventListener('updatefound', () => {
          const worker = registration.installing;
          worker?.addEventListener('statechange', () => {
            if (worker.state === 'installed' && navigator.serviceWorker.controller) {
              window.dispatchEvent(new CustomEvent('update-ready'));
            }
          });
        });
      })
      .catch((error: unknown) => console.warn('离线缓存未能启用', error));
  });
}
