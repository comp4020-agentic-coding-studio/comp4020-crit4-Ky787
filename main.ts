import { App } from "./src/app.ts";

const app = new App();
void app.start();

// An inspection handle. Audio is the one thing about this project a test cannot
// see from the DOM, so the browser checks reach in here to prove that different
// General MIDI programs really do produce different sound rather than the same
// piano twelve times. Harmless in the shipped page, and useful in a console.
declare global {
  interface Window {
    rubato: App;
  }
}
window.rubato = app;
