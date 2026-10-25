import { useCallback, useEffect, useRef, useState } from "react";

// Web Speech API isn't in TS's DOM lib yet; only the bits we use.
type Recognition = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  onresult: (e: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void;
  onerror: (e: { error: string }) => void;
  onend: () => void;
};
type RecognitionCtor = new () => Recognition;

const SR: RecognitionCtor | undefined =
  (window as unknown as { SpeechRecognition?: RecognitionCtor }).SpeechRecognition ??
  (window as unknown as { webkitSpeechRecognition?: RecognitionCtor }).webkitSpeechRecognition;

export function useSpeech(onFinal: (text: string) => void) {
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState("");
  const [error, setError] = useState<string | null>(null);
  const rec = useRef<Recognition | null>(null);
  const wanted = useRef(false);
  const onFinalRef = useRef(onFinal);
  onFinalRef.current = onFinal;

  const start = useCallback(() => {
    if (!SR) return;
    const r = new SR();
    r.continuous = true;
    r.interimResults = true;
    r.lang = navigator.language;
    r.onresult = (e) => {
      let partial = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        if (res.isFinal) onFinalRef.current(res[0].transcript.trim());
        else partial += res[0].transcript;
      }
      setInterim(partial);
    };
    r.onerror = (e) => {
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        wanted.current = false;
        setError("Microphone access was denied.");
      }
    };
    // Chrome ends recognition after silence; keep it alive while the toggle is on.
    r.onend = () => {
      setInterim("");
      if (!wanted.current) return setListening(false);
      setTimeout(() => {
        try {
          if (wanted.current) r.start();
        } catch {
          // already started
        }
      }, 300);
    };
    wanted.current = true;
    rec.current = r;
    setError(null);
    r.start();
    setListening(true);
  }, []);

  const stop = useCallback(() => {
    wanted.current = false;
    rec.current?.stop();
    setListening(false);
  }, []);

  useEffect(() => () => stop(), [stop]);

  return { supported: !!SR, listening, interim, error, start, stop };
}
