import { render } from 'preact';
import 'remixicon/fonts/remixicon.css';
import './styles.css';
import { App } from './App.jsx';

render(<App />, document.getElementById('app'));

if (import.meta.env.PROD && 'serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register(new URL('sw.js', document.baseURI), { updateViaCache: 'none' }).catch((error) => {
    console.warn('Offline shell registration failed:', error.message);
  });
}
