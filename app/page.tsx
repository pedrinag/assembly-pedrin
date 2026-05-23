"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile, toBlobURL } from "@ffmpeg/util";

type JobStatus = "waiting" | "extracting" | "uploading" | "queued" | "processing" | "completed" | "error";

interface Job {
  id: string;
  name: string;
  size: number;
  createdAt: number;
  status: JobStatus;
  transcriptId?: string;
  text?: string;
  error?: string;
  uploadProgress?: number;
  extractProgress?: number;
}

let ffmpegInstance: FFmpeg | null = null;
let ffmpegLoading: Promise<FFmpeg> | null = null;

async function getFFmpeg(): Promise<FFmpeg> {
  if (ffmpegInstance) return ffmpegInstance;
  if (ffmpegLoading) return ffmpegLoading;
  ffmpegLoading = (async () => {
    const ff = new FFmpeg();
    const baseURL = "https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd";
    await ff.load({
      coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, "text/javascript"),
      wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, "application/wasm"),
    });
    ffmpegInstance = ff;
    return ff;
  })();
  return ffmpegLoading;
}

let ffmpegQueue: Promise<any> = Promise.resolve();

function queueFFmpeg<T>(task: () => Promise<T>): Promise<T> {
  const run = ffmpegQueue.then(task, task);
  ffmpegQueue = run.catch(() => {});
  return run;
}

async function extractAudio(file: File, onProgress: (pct: number) => void): Promise<Blob> {
  return queueFFmpeg(async () => {
    const ff = await getFFmpeg();
    const ext = (file.name.split(".").pop() || "mp4").toLowerCase().replace(/[^a-z0-9]/g, "");
    const id = Math.random().toString(36).slice(2);
    const inputName = `in_${id}.${ext}`;
    const outputName = `out_${id}.mp3`;
    const progressHandler = ({ progress }: { progress: number }) => {
      onProgress(Math.min(99, Math.round(progress * 100)));
    };
    ff.on("progress", progressHandler);
    try {
      await ff.writeFile(inputName, await fetchFile(file));
      await ff.exec([
        "-i", inputName,
        "-vn",
        "-ac", "1",
        "-ar", "16000",
        "-b:a", "64k",
        outputName,
      ]);
      const data = await ff.readFile(outputName);
      return new Blob([data], { type: "audio/mpeg" });
    } finally {
      ff.off("progress", progressHandler);
      try { await ff.deleteFile(inputName); } catch {}
      try { await ff.deleteFile(outputName); } catch {}
    }
  });
}

const STORAGE_KEY = "transcriber.jobs.v1";
const KEY_STORAGE = "transcriber.key.v1";

function formatTranscript(d: any): string {
  if (Array.isArray(d.utterances) && d.utterances.length > 0) {
    return d.utterances
      .map((u: any) => `Speaker ${u.speaker}: ${u.text}`)
      .join("\n\n");
  }
  return d.text || "";
}

export default function Page() {
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [requiresPassword, setRequiresPassword] = useState(false);
  const [password, setPassword] = useState("");
  const [authError, setAuthError] = useState<string | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      try { setJobs(JSON.parse(stored)); } catch {}
    }
    const cachedKey = sessionStorage.getItem(KEY_STORAGE);
    if (cachedKey) {
      setApiKey(cachedKey);
      return;
    }
    fetch("/api/key").then(r => r.json()).then(d => {
      if (d.requiresPassword) {
        setRequiresPassword(true);
      } else {
        fetchKey("");
      }
    });
  }, []);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(jobs));
  }, [jobs]);

  const updateJob = useCallback((id: string, patch: Partial<Job>) => {
    setJobs(prev => prev.map(j => j.id === id ? { ...j, ...patch } : j));
  }, []);

  const fetchKey = async (pwd: string) => {
    setAuthError(null);
    const r = await fetch("/api/key", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: pwd }),
    });
    const d = await r.json();
    if (!r.ok) {
      setAuthError(d.error || "Erro de autenticação");
      return;
    }
    sessionStorage.setItem(KEY_STORAGE, d.apiKey);
    setApiKey(d.apiKey);
  };

  // Poll de jobs em andamento
  useEffect(() => {
    if (!apiKey) return;
    const pending = jobs.filter(j => j.status === "queued" || j.status === "processing");
    if (pending.length === 0) return;
    const interval = setInterval(() => {
      pending.forEach(async (job) => {
        if (!job.transcriptId) return;
        try {
          const r = await fetch(`https://api.assemblyai.com/v2/transcript/${job.transcriptId}`, {
            headers: { authorization: apiKey },
          });
          const d = await r.json();
          if (d.status === "completed") {
            const text = formatTranscript(d);
            updateJob(job.id, { status: "completed", text });
          } else if (d.status === "error") {
            updateJob(job.id, { status: "error", error: d.error || "Erro na transcrição" });
          } else if (d.status === "processing") {
            updateJob(job.id, { status: "processing" });
          }
        } catch (e: any) {
          updateJob(job.id, { status: "error", error: e.message });
        }
      });
    }, 2500);
    return () => clearInterval(interval);
  }, [apiKey, jobs, updateJob]);

  const handleFiles = async (files: FileList | File[]) => {
    if (!apiKey) return;
    const list = Array.from(files).sort((a, b) =>
      a.name.localeCompare(b.name, "pt-BR", { numeric: true, sensitivity: "base" })
    );
    for (const file of list) {
      const id = crypto.randomUUID();
      const isVideo = file.type.startsWith("video/") || /\.(mp4|mov|mkv|webm|avi|flv|wmv)$/i.test(file.name);
      const job: Job = {
        id, name: file.name, size: file.size, createdAt: Date.now(),
        status: isVideo ? "waiting" : "uploading",
        uploadProgress: 0, extractProgress: 0,
      };
      setJobs(prev => [job, ...prev]);
      uploadAndTranscribe(file, id, apiKey, isVideo);
    }
  };

  const uploadAndTranscribe = async (file: File, id: string, key: string, isVideo: boolean) => {
    try {
      let toUpload: Blob = file;
      if (isVideo) {
        toUpload = await extractAudio(file, (pct) => {
          updateJob(id, { status: "extracting", extractProgress: pct });
        });
        updateJob(id, { status: "uploading", extractProgress: 100 });
      }
      const uploadUrl = await uploadWithProgress(toUpload, key, (pct) => {
        updateJob(id, { uploadProgress: pct });
      });
      const r = await fetch("https://api.assemblyai.com/v2/transcript", {
        method: "POST",
        headers: { authorization: key, "content-type": "application/json" },
        body: JSON.stringify({
          audio_url: uploadUrl,
          language_code: "pt",
          speech_model: "universal",
          speaker_labels: true,
        }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "Erro ao criar transcrição");
      updateJob(id, { status: "queued", transcriptId: d.id, uploadProgress: 100 });
    } catch (e: any) {
      updateJob(id, { status: "error", error: e.message });
    }
  };

  const uploadWithProgress = (file: Blob, key: string, onProgress: (pct: number) => void): Promise<string> => {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", "https://api.assemblyai.com/v2/upload");
      xhr.setRequestHeader("authorization", key);
      xhr.setRequestHeader("content-type", "application/octet-stream");
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            const d = JSON.parse(xhr.responseText);
            resolve(d.upload_url);
          } catch (e) { reject(e); }
        } else {
          reject(new Error(`Upload falhou: ${xhr.status} ${xhr.responseText}`));
        }
      };
      xhr.onerror = () => reject(new Error("Erro de rede no upload"));
      xhr.send(file);
    });
  };

  const downloadOne = (job: Job) => {
    if (!job.text) return;
    const blob = new Blob([job.text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${job.name.replace(/\.[^.]+$/, "")}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const downloadAll = async () => {
    const completed = jobs.filter(j => j.status === "completed" && j.text);
    if (completed.length === 0) return;
    // Combina em um único arquivo
    const combined = completed.map(j =>
      `===== ${j.name} =====\n\n${j.text}\n\n`
    ).join("");
    const blob = new Blob([combined], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `transcricoes-${new Date().toISOString().slice(0, 10)}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const removeJob = (id: string) => {
    setJobs(prev => prev.filter(j => j.id !== id));
  };

  const clearAll = () => {
    if (!confirm("Apagar todas as transcrições da lista?")) return;
    setJobs([]);
  };

  if (requiresPassword && !apiKey) {
    return (
      <main>
        <h1>Transcritor de Vídeos</h1>
        <p className="sub">Digite a senha para começar.</p>
        <div className="gate">
          <input
            type="password"
            placeholder="Senha"
            value={password}
            onChange={e => setPassword(e.target.value)}
            onKeyDown={e => e.key === "Enter" && fetchKey(password)}
          />
          <button onClick={() => fetchKey(password)}>Entrar</button>
          {authError && <div className="error-msg">{authError}</div>}
        </div>
      </main>
    );
  }

  if (!apiKey) {
    return <main><p>Carregando…</p></main>;
  }

  const completedCount = jobs.filter(j => j.status === "completed").length;

  return (
    <main>
      <h1>Transcritor de Vídeos</h1>
      <p className="sub">Arraste vídeos ou clique para selecionar. Transcrição automática via AssemblyAI.</p>

      <div
        className={`dropzone ${dragOver ? "drag" : ""}`}
        onClick={() => fileInputRef.current?.click()}
        onDragOver={e => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={e => {
          e.preventDefault();
          setDragOver(false);
          handleFiles(e.dataTransfer.files);
        }}
      >
        <strong>Clique ou arraste vídeos aqui</strong>
        <p>MP4, MOV, MKV, MP3, WAV — vários arquivos ao mesmo tempo</p>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept="video/*,audio/*"
          onChange={e => e.target.files && handleFiles(e.target.files)}
        />
      </div>

      {jobs.length > 0 && (
        <div className="bulk">
          <button onClick={downloadAll} disabled={completedCount === 0}>
            Baixar todas ({completedCount})
          </button>
          <button className="ghost" onClick={clearAll}>Limpar lista</button>
        </div>
      )}

      <div className="list">
        {jobs.map(job => (
          <div key={job.id} className="job">
            <div className="job-header">
              <div className="job-name">{job.name}</div>
              <span className={`status ${job.status}`}>
                {job.status === "waiting" && "Aguardando vez"}
                {job.status === "extracting" && `Extraindo áudio ${job.extractProgress ?? 0}%`}
                {job.status === "uploading" && `Upload ${job.uploadProgress ?? 0}%`}
                {job.status === "queued" && "Na fila"}
                {job.status === "processing" && "Transcrevendo"}
                {job.status === "completed" && "Pronto"}
                {job.status === "error" && "Erro"}
              </span>
            </div>
            {job.status === "extracting" && (
              <div className="progress"><div style={{ width: `${job.extractProgress ?? 0}%` }} /></div>
            )}
            {job.status === "uploading" && (
              <div className="progress"><div style={{ width: `${job.uploadProgress ?? 0}%` }} /></div>
            )}
            {job.error && <div className="error-msg">{job.error}</div>}
            <div className="actions">
              {job.status === "completed" && (
                <button onClick={() => downloadOne(job)}>Baixar TXT</button>
              )}
              <button className="ghost" onClick={() => removeJob(job.id)}>Remover</button>
            </div>
          </div>
        ))}
      </div>
    </main>
  );
}
