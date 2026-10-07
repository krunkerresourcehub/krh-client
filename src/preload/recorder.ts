// ── Recorder window preload ──
// Runs inside a hidden window owned by src/main/recorder.ts. It asks Chromium for a capture stream
// of the game window (the main process answers via setDisplayMediaRequestHandler), records it with
// MediaRecorder and streams the encoded data back to the main process, which writes it to disk.
import { ipcRenderer } from 'electron';

interface StartOpts { fps: number; bps: number; audio: boolean; mic?: boolean }

let rec: MediaRecorder | null = null;
let stream: MediaStream | null = null;     // what the browser gave us (video + maybe game/system audio)
let micStream: MediaStream | null = null;
let audioCtx: AudioContext | null = null;
let queue: Promise<void> = Promise.resolve();
let stopping = false;

function cleanup(): void {
  try { stream?.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ }
  try { micStream?.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ }
  try { void audioCtx?.close(); } catch { /* ignore */ }
  stream = null;
  micStream = null;
  audioCtx = null;
  rec = null;
}

ipcRenderer.on('krh-rec-start', async (_e, o: StartOpts) => {
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: o.fps, max: o.fps } },
      audio: o.audio,
    });

    // Optional microphone: mix it with the captured audio into a single audio track.
    let micFailed = false;
    let recordStream: MediaStream = stream;
    if (o.mic) {
      try {
        micStream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
      } catch {
        micFailed = true; // no mic / permission denied by the OS: record without it
      }
    }
    if (micStream) {
      audioCtx = new AudioContext();
      await audioCtx.resume();
      const dest = audioCtx.createMediaStreamDestination();
      // Slightly below full scale each so game audio + voice together don't clip.
      const gameGain = audioCtx.createGain(); gameGain.gain.value = 0.7; gameGain.connect(dest);
      const micGain = audioCtx.createGain(); micGain.gain.value = 0.85; micGain.connect(dest);
      if (stream.getAudioTracks().length) {
        audioCtx.createMediaStreamSource(new MediaStream(stream.getAudioTracks())).connect(gameGain);
      }
      audioCtx.createMediaStreamSource(micStream).connect(micGain);
      recordStream = new MediaStream([...stream.getVideoTracks(), ...dest.stream.getAudioTracks()]);
    }
    // MP4 (H.264) first: plays everywhere and uploads to YouTube/Streamable/Discord without conversion.
    // AAC audio is preferred; Opus-in-MP4 where no AAC encoder exists; WebM is the last resort.
    const mime = [
      'video/mp4;codecs=avc1.64002A,mp4a.40.2',
      'video/mp4;codecs=avc1,mp4a.40.2',
      'video/mp4;codecs=avc1.64002A,opus',
      'video/mp4;codecs=avc1,opus',
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm',
    ].find((m) => MediaRecorder.isTypeSupported(m));
    rec = new MediaRecorder(recordStream, {
      mimeType: mime,
      videoBitsPerSecond: o.bps,
      audioBitsPerSecond: 128_000,
    });
    rec.ondataavailable = (ev: BlobEvent) => {
      if (!ev.data.size) return;
      // Chain the sends so chunks reach the main process in order.
      queue = queue.then(async () => { ipcRenderer.send('krh-rec-chunk', await ev.data.arrayBuffer()); });
    };
    rec.onerror = () => { ipcRenderer.send('krh-rec-error', 'MediaRecorder error'); };
    rec.onstop = () => {
      queue.then(() => { cleanup(); ipcRenderer.send('krh-rec-stopped'); });
    };
    // If the captured window goes away (game window closed), finish cleanly.
    stream.getVideoTracks()[0]?.addEventListener('ended', () => { if (!stopping && rec?.state === 'recording') rec.stop(); });
    stopping = false;
    rec.start(1000);
    const vs = stream.getVideoTracks()[0]?.getSettings() ?? {};
    ipcRenderer.send('krh-rec-started', {
      width: vs.width ?? 0, height: vs.height ?? 0, hasAudio: recordStream.getAudioTracks().length > 0,
      mic: !!micStream, micFailed,
      mime: rec.mimeType || mime || '',
    });
  } catch (err) {
    cleanup();
    ipcRenderer.send('krh-rec-error', String(err));
  }
});

ipcRenderer.on('krh-rec-pause', () => {
  if (rec?.state === 'recording') { rec.pause(); ipcRenderer.send('krh-rec-pause-state', true); }
});

ipcRenderer.on('krh-rec-resume', () => {
  if (rec?.state === 'paused') { rec.resume(); ipcRenderer.send('krh-rec-pause-state', false); }
});

ipcRenderer.on('krh-rec-stop', () => {
  stopping = true;
  if (rec && rec.state !== 'inactive') rec.stop();
  else { cleanup(); ipcRenderer.send('krh-rec-stopped'); }
});
