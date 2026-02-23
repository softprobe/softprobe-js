/**
 * Boot entry: softprobe/init.
 * Must be imported first (before OTel). Reads SOFTPROBE_MODE and runs
 * CAPTURE or REPLAY init accordingly; design §4.1, §11.
 */

const mode = process.env.SOFTPROBE_MODE;

if (mode === 'CAPTURE') {
  const { initCapture } = require('./capture/init');
  initCapture();
}
// REPLAY: mode-specific init (e.g. cassette load) in task 11.1.2; no-op here
