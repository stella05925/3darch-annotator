// Entry point. Modules: state (shared state, helpers) · registry (element types) · model / build (data rules,
// geometry) · render (three.js scene, levels, cameras) · selection · snap / handles / tools (interaction) ·
// commands (edits, undo) · review · panel · ui (wiring, keyboard) · logging / logger · scene (load, save, startup).
import { start } from './scene.js';
import { setProgress, log } from './state.js';

start().catch((err) => {
  console.error(err);
  setProgress(`Failed: ${err}`, 0);
  log('error', { message: String(err), stage: 'startup' });
});
