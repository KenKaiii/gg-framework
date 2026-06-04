/**
 * Voice note transcription using local Whisper model.
 * Uses @huggingface/transformers (pure JS/WASM) — no native deps, no API keys.
 * Model (~75MB) is downloaded on first use and cached locally.
 */

import type { AutomaticSpeechRecognitionPipeline } from "@huggingface/transformers";

const TARGET_SAMPLE_RATE = 16000;
const MODEL_ID = "Xenova/whisper-tiny.en";

let transcriber: AutomaticSpeechRecognitionPipeline | null = null;
let loadPromise: Promise<AutomaticSpeechRecognitionPipeline> | null = null;

/** Optional callback for model download progress. */
export type ProgressCallback = (info: { status: string; progress?: number; file?: string }) => void;

let onProgress: ProgressCallback | null = null;

/** Set a callback to receive model download progress updates. */
export function setProgressCallback(cb: ProgressCallback | null): void {
  onProgress = cb;
}

/**
 * Resample audio from one sample rate to another using linear interpolation.
 */
export function resample(audio: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate) return audio;
  const ratio = fromRate / toRate;
  const newLength = Math.round(audio.length / ratio);
  const result = new Float32Array(newLength);
  for (let i = 0; i < newLength; i++) {
    const srcIndex = i * ratio;
    const low = Math.floor(srcIndex);
    const high = Math.min(low + 1, audio.length - 1);
    const frac = srcIndex - low;
    result[i] = audio[low]! * (1 - frac) + audio[high]! * frac;
  }
  return result;
}

/**
 * Downmix multi-channel audio to mono by averaging all channels.
 */
export function downmixToMono(channelData: Float32Array[]): Float32Array {
  if (channelData.length === 0) return new Float32Array();
  if (channelData.length === 1) return channelData[0]!;

  const samples = channelData[0]!.length;
  const out = new Float32Array(samples);
  const scale = 1 / channelData.length;
  for (let i = 0; i < samples; i++) {
    let mixed = 0;
    for (const channel of channelData) mixed += channel[i] ?? 0;
    out[i] = mixed * scale;
  }
  return out;
}

/**
 * Decode OGG Opus audio buffer to 16kHz mono PCM Float32Array.
 */
export async function decodeOggOpus(buffer: Uint8Array): Promise<Float32Array> {
  const { OggOpusDecoder } = await import("ogg-opus-decoder");
  const decoder = new OggOpusDecoder();
  await decoder.ready;
  try {
    const decoded = await decoder.decodeFile(buffer);

    if (!decoded.channelData?.length || !decoded.channelData[0]?.length) {
      throw new Error("Decoded audio is empty");
    }

    const mono = downmixToMono(decoded.channelData);
    return resample(mono, decoded.sampleRate, TARGET_SAMPLE_RATE);
  } finally {
    decoder.free();
  }
}

/**
 * Get or initialize the Whisper transcription pipeline.
 * Model is downloaded on first use and cached by transformers.js.
 */
async function getTranscriber(): Promise<AutomaticSpeechRecognitionPipeline> {
  if (transcriber) return transcriber;

  if (!loadPromise) {
    loadPromise = (async () => {
      const { pipeline } = await import("@huggingface/transformers");
      const instance = await pipeline("automatic-speech-recognition", MODEL_ID, {
        dtype: "fp32",
        progress_callback: onProgress ?? undefined,
      });
      transcriber = instance;
      return instance;
    })();
  }

  return loadPromise;
}

/** Whether the model has been loaded already. */
export function isModelLoaded(): boolean {
  return transcriber !== null;
}

/**
 * Transcribe a voice message from its Telegram file URL.
 * Downloads the OGG Opus file, decodes to PCM, and runs Whisper locally.
 */
export async function transcribeVoice(fileUrl: string): Promise<string> {
  // Download the audio file
  const response = await fetch(fileUrl);
  if (!response.ok) throw new Error(`Failed to download voice file: ${response.status}`);
  const buffer = new Uint8Array(await response.arrayBuffer());

  // Decode OGG Opus → 16kHz mono PCM
  const pcm = await decodeOggOpus(buffer);

  // Transcribe with Whisper
  const asr = await getTranscriber();
  const result = await asr(pcm);

  const text = Array.isArray(result) ? result[0]?.text : (result as { text: string }).text;
  return (text ?? "").trim();
}
