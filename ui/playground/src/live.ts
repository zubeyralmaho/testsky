/**
 * The phone's screen as it moves (packages/playground/src/screen.ts): H.264
 * pictures straight off the phone's own encoder, decoded here with WebCodecs
 * and drawn on a canvas.
 *
 * The server sends messages of [length, 4 bytes big-endian][kind, 1 byte]
 * [payload]: the codec's name, then pictures, a key picture first. A picture
 * the decoder cannot take closes it; the next key picture opens another --
 * the server restarts the phone's encoder for one when a picture was cut
 * short.
 */

const KIND = { picture: 0, keyPicture: 1, codec: 2 } as const;

export interface LiveScreen {
  close(): void;
}

/** Whether this browser can show the live screen at all. */
export const canShowLive = () => typeof window !== 'undefined' && 'VideoDecoder' in window;

function joined(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (!a.length) return b;
  const both = new Uint8Array(a.length + b.length);
  both.set(a);
  both.set(b, a.length);
  return both;
}

/**
 * Opens the stream and draws every picture on `canvas`, sized to the
 * pictures. `onPicture` hears of each one drawn; `onEnd` of the stream
 * ending for any reason but `close`, and why.
 */
export function openLiveScreen(
  canvas: HTMLCanvasElement,
  events: { onPicture: () => void; onEnd: (reason: string) => void },
): LiveScreen {
  const controller = new AbortController();
  let decoder: VideoDecoder | undefined;
  let codec: string | undefined;
  let closed = false;
  let timestamp = 0;

  const draw = (frame: VideoFrame) => {
    if (closed) {
      frame.close();
      return;
    }
    if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
      canvas.width = frame.displayWidth;
      canvas.height = frame.displayHeight;
    }
    canvas.getContext('2d')?.drawImage(frame, 0, 0);
    frame.close();
    events.onPicture();
  };

  // A decoder that fails is closed for good; the next key picture opens another.
  const decoderFor = (name: string) => {
    const opened = new VideoDecoder({
      output: draw,
      error: () => {
        if (decoder === opened) decoder = undefined;
      },
    });
    opened.configure({ codec: name, optimizeForLatency: true });
    return opened;
  };

  const take = async (kind: number, payload: Uint8Array) => {
    if (kind === KIND.codec) {
      const name = new TextDecoder().decode(payload);
      const { supported } = await VideoDecoder.isConfigSupported({ codec: name });
      if (!supported) throw new Error(`this browser cannot decode the phone's ${name}`);
      codec = name;
      decoder?.close();
      decoder = undefined;
      return;
    }
    if (!codec) return;
    const key = kind === KIND.keyPicture;
    if (!decoder) {
      if (!key) return;
      decoder = decoderFor(codec);
    }
    // Each picture is drawn as it comes; the times only have to rise.
    timestamp += 16_667;
    decoder.decode(new EncodedVideoChunk({ type: key ? 'key' : 'delta', timestamp, data: payload }));
  };

  const run = async () => {
    const response = await fetch('/api/screen', { signal: controller.signal, cache: 'no-store' });
    if (!response.ok || !response.body) throw new Error(`the live screen answered ${response.status}`);
    const reader = response.body.getReader();
    let buffer: Uint8Array = new Uint8Array(0);
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer = joined(buffer, value);
      while (buffer.length >= 5) {
        const length = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength).getUint32(0);
        if (buffer.length < 5 + length) break;
        await take(buffer[4]!, buffer.slice(5, 5 + length));
        buffer = buffer.slice(5 + length);
      }
    }
  };

  run().then(
    () => {
      if (!closed) events.onEnd('the phone stopped streaming its screen');
    },
    (error: unknown) => {
      if (!closed) events.onEnd((error as Error).message);
    },
  );

  return {
    close() {
      closed = true;
      controller.abort();
      if (decoder && decoder.state !== 'closed') decoder.close();
      decoder = undefined;
    },
  };
}
