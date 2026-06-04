// Moved to @kenkaiiii/gg-core. Shim keeps `../core/voice-transcriber.js`
// imports working.
export {
  setProgressCallback,
  resample,
  downmixToMono,
  decodeOggOpus,
  isModelLoaded,
  transcribeVoice,
  type ProgressCallback,
} from "@kenkaiiii/gg-core";
