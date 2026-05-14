import http from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");
const IS_VERCEL = Boolean(process.env.VERCEL);
const DATA_DIR = process.env.DATA_DIR || (IS_VERCEL ? path.join("/tmp", "farcelis-meeting-monitor-data") : path.join(__dirname, "data"));
const MEETINGS_DIR = path.join(DATA_DIR, "meetings");
const CLIENTS_DIR = path.join(DATA_DIR, "clients");
const INBOX_DIR = path.join(DATA_DIR, "inbox");
const CLIENT_REGISTRY_FILE = path.join(DATA_DIR, "client-registry.json");
const CALENDAR_RULES_FILE = path.join(DATA_DIR, "calendar-rules.json");
const SPEAKER_REGISTRY_FILE = path.join(DATA_DIR, "speaker-registry.json");
const NATIVE_RECORDER = path.join(__dirname, "native", "SystemAudioRecorder");
const AUDIO_CLIPPER = path.join(__dirname, "native", "AudioClipper");
const MAC_SPEECH_TRANSCRIBER_APP = path.join(__dirname, "native", "MacSpeechTranscriber.app");
const MAC_SPEECH_TRANSCRIBER = path.join(MAC_SPEECH_TRANSCRIBER_APP, "Contents", "MacOS", "MacSpeechTranscriber");
const CALENDAR_READER = path.join(__dirname, "native", "CalendarReader");
const WHISPER_CLI = process.env.WHISPER_CLI || path.join(__dirname, "vendor", "whisper.cpp", "build", "bin", "whisper-cli");
const WHISPER_MODEL = process.env.WHISPER_MODEL || path.join(__dirname, "vendor", "whisper.cpp", "models", "ggml-base.en.bin");
const nativeRecorders = new Map();

await loadEnvFile(path.join(__dirname, ".env"));

const PORT = Number(process.env.PORT || 8787);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const TRANSCRIPTION_PROVIDER = process.env.TRANSCRIPTION_PROVIDER || (OPENAI_API_KEY ? "openai" : "local");
const LOCAL_TRANSCRIBE_PROVIDER = process.env.LOCAL_TRANSCRIBE_PROVIDER || "macos-speech";
const LOCAL_TRANSCRIBE_LOCALE = process.env.LOCAL_TRANSCRIBE_LOCALE || "en_US";
const LOCAL_TRANSCRIBE_ALLOW_NETWORK = ["1", "true", "yes"].includes(String(process.env.LOCAL_TRANSCRIBE_ALLOW_NETWORK || "").toLowerCase());
const TRANSCRIBE_MODEL = process.env.OPENAI_TRANSCRIBE_MODEL || "gpt-4o-mini-transcribe";
const DIARIZE_MODEL = process.env.OPENAI_DIARIZE_MODEL || "gpt-4o-transcribe-diarize";
const SUMMARY_MODEL = process.env.OPENAI_SUMMARY_MODEL || "gpt-4.1-mini";
const VOICEPRINT_MATCH_THRESHOLD = Number(process.env.VOICEPRINT_MATCH_THRESHOLD || 0.9);
const NATIVE_RECORDING_SUPPORTED = !IS_VERCEL && process.platform === "darwin";

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webm": "audio/webm",
  ".wav": "audio/wav",
  ".md": "text/markdown; charset=utf-8"
};

await ensureDirs();

export async function handleRequest(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url);
      return;
    }

    await serveStatic(url.pathname, res);
  } catch (error) {
    console.error(error);
    sendJson(res, 500, { error: error.message || "Unexpected server error" });
  }
}

export default handleRequest;

if (!IS_VERCEL && process.argv[1] === fileURLToPath(import.meta.url)) {
  const server = http.createServer(handleRequest);
  server.listen(PORT, () => {
    console.log(`Farcelis Meeting Monitor running at http://localhost:${PORT}`);
  });
}

async function loadEnvFile(filePath) {
  try {
    const content = await fs.readFile(filePath, "utf8");
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const index = trimmed.indexOf("=");
      if (index === -1) continue;
      const key = trimmed.slice(0, index).trim();
      const value = trimmed.slice(index + 1).trim();
      if (key && process.env[key] === undefined) process.env[key] = value;
    }
  } catch {
    // .env is optional. Environment variables can be supplied by the shell.
  }
}

async function ensureDirs() {
  await Promise.all([
    fs.mkdir(MEETINGS_DIR, { recursive: true }),
    fs.mkdir(CLIENTS_DIR, { recursive: true }),
    fs.mkdir(INBOX_DIR, { recursive: true })
  ]);
}

async function handleApi(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/status") {
    sendJson(res, 200, {
      openaiConfigured: Boolean(OPENAI_API_KEY),
      transcriptionProvider: TRANSCRIPTION_PROVIDER,
      localTranscribeProvider: LOCAL_TRANSCRIBE_PROVIDER,
      nativeRecordingSupported: NATIVE_RECORDING_SUPPORTED,
      storageMode: IS_VERCEL ? "ephemeral-cloud" : "local-filesystem",
      models: {
      live: TRANSCRIBE_MODEL,
        diarize: DIARIZE_MODEL,
        summary: SUMMARY_MODEL
      }
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/meetings") {
    sendJson(res, 200, { meetings: await listMeetings() });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/clients") {
    sendJson(res, 200, { clients: (await readClientRegistry()).clients });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/speakers") {
    const client = cleanName(url.searchParams.get("client") || "");
    const registry = await readSpeakerRegistry();
    const speakers = client
      ? registry.speakers.filter((speaker) => speaker.clients?.includes(client))
      : registry.speakers;
    sendJson(res, 200, { speakers });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/calendar/events") {
    const daysBack = Number(url.searchParams.get("daysBack") || 1);
    const daysForward = Number(url.searchParams.get("daysForward") || 14);
    const rawEvents = await readNativeCalendarEvents(daysBack, daysForward);
    const rules = await readCalendarRules();
    const events = cleanCalendarEvents(rawEvents, rules);
    sendJson(res, 200, { events, rawCount: rawEvents.length, filteredCount: rawEvents.length - events.length, timezone: rules.timezone });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/meetings") {
    const body = await readJson(req);
    const meeting = await createMeeting(body);
    sendJson(res, 201, { meeting });
    return;
  }

  const meetingMatch = url.pathname.match(/^\/api\/meetings\/([^/]+)(?:\/([^/]+))?$/);
  if (meetingMatch) {
    const [, meetingId, action] = meetingMatch;
    if (req.method === "GET" && !action) {
      sendJson(res, 200, { meeting: await readMeeting(meetingId) });
      return;
    }
    if (req.method === "GET" && action === "audio-clip") {
      const clip = await getAudioClip(meetingId, url.searchParams);
      await sendFile(res, clip.filePath, "audio/mp4");
      return;
    }
    if (req.method === "POST" && action === "recording") {
      const buffer = await readBuffer(req);
      const meta = await saveRecording(meetingId, buffer, req.headers["content-type"] || "audio/webm");
      sendJson(res, 200, { recording: meta });
      return;
    }
    if (req.method === "POST" && action === "native-start") {
      const result = await startNativeRecording(meetingId);
      sendJson(res, 200, result);
      return;
    }
    if (req.method === "POST" && action === "native-stop") {
      const result = await stopNativeRecording(meetingId);
      sendJson(res, 200, result);
      return;
    }
    if (req.method === "POST" && action === "chunk") {
      const buffer = await readBuffer(req);
      const transcript = await saveAndTranscribeChunk(meetingId, buffer, req.headers["content-type"] || "audio/webm");
      sendJson(res, 200, transcript);
      return;
    }
    if (req.method === "POST" && action === "finalize") {
      const result = await finalizeMeeting(meetingId);
      sendJson(res, 200, result);
      return;
    }
    if (req.method === "POST" && action === "speaker-overrides") {
      const body = await readJson(req);
      const meeting = await saveSpeakerOverride(meetingId, body);
      sendJson(res, 200, { meeting });
      return;
    }
    if (req.method === "POST" && action === "speaker-reconcile") {
      const meeting = await reconcileMeetingSpeakers(meetingId);
      sendJson(res, 200, { meeting });
      return;
    }
    if (req.method === "POST" && action === "prep") {
      const body = await readJson(req);
      const prep = await buildPrep(body);
      sendJson(res, 200, { prep });
      return;
    }
    if (req.method === "POST" && action === "calendar-match") {
      const body = await readJson(req);
      const matches = await matchCalendar(body);
      sendJson(res, 200, { matches });
      return;
    }
  }

  sendJson(res, 404, { error: "Not found" });
}

async function serveStatic(pathname, res) {
  const safePath = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.normalize(path.join(PUBLIC_DIR, safePath));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendJson(res, 403, { error: "Forbidden" });
    return;
  }

  try {
    const data = await fs.readFile(filePath);
    res.writeHead(200, { "Content-Type": MIME_TYPES[path.extname(filePath)] || "application/octet-stream" });
    res.end(data);
  } catch {
    sendJson(res, 404, { error: "Not found" });
  }
}

async function listMeetings() {
  const entries = await fs.readdir(MEETINGS_DIR, { withFileTypes: true });
  const meetings = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      meetings.push(await readMeeting(entry.name));
    } catch {
      // Ignore incomplete folders.
    }
  }
  return meetings.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

async function createMeeting(input = {}) {
  const now = new Date();
  const client = cleanName(input.client || "Unassigned");
  const title = input.title?.trim() || "Untitled Meeting";
  const id = `${dateStamp(now)}-${slugify(client)}-${slugify(title)}-${randomUUID().slice(0, 8)}`;
  const folder = path.join(MEETINGS_DIR, id);
  await fs.mkdir(path.join(folder, "chunks"), { recursive: true });

  const meeting = {
    id,
    title,
    client,
    attendees: input.attendees || "",
    platform: input.platform || "Independent",
    notes: input.notes || "",
    consent: Boolean(input.consent),
    createdAt: now.toISOString(),
    startedAt: null,
    stoppedAt: null,
    status: "created",
    files: {
      recording: null,
      systemAudio: null,
      microphoneAudio: null,
      transcript: "transcript.md",
      diarized: "diarized.json",
      brief: "brief.md",
      prep: "prep.md"
    },
    liveTranscript: [],
    speakerOverrides: {}
  };

  await writeMeeting(meeting);
  await ensureClientFolder(client);
  return meeting;
}

async function readMeeting(meetingId) {
  const json = await fs.readFile(path.join(MEETINGS_DIR, meetingId, "meeting.json"), "utf8");
  return JSON.parse(json);
}

async function saveSpeakerOverride(meetingId, input = {}) {
  const keys = Array.isArray(input.keys)
    ? input.keys.map((item) => String(item || "").trim()).filter(Boolean)
    : [String(input.key || "").trim()].filter(Boolean);
  const speaker = cleanName(input.speaker || "");
  if (!keys.length) throw new Error("Speaker override key is required.");
  const meeting = await readMeeting(meetingId);
  meeting.speakerOverrides = meeting.speakerOverrides || {};
  const folder = path.join(MEETINGS_DIR, meetingId);
  const diarization = await readOrBuildLocalDiarization(folder, meeting);
  const labeledSegments = keys
    .map((key) => diarization.segments.find((segment) => segment.key === key))
    .filter(Boolean);

  if (speaker) {
    for (const key of keys) meeting.speakerOverrides[key] = speaker;
    for (const segment of labeledSegments) {
      await registerSpeaker(speaker, meeting.client, segment.voiceprint, segment.trackType);
    }
    let applied = 0;
    for (const segment of labeledSegments) {
      applied += await applyVoiceprintLabels(meeting, diarization, speaker, segment);
    }
    meeting.speakerLearning = {
      ...(meeting.speakerLearning || {}),
      lastLabelAt: new Date().toISOString(),
      lastLabel: speaker,
      lastLabeledSegmentCount: keys.length,
      lastAppliedCount: applied
    };
  } else {
    for (const key of keys) delete meeting.speakerOverrides[key];
  }
  await applyKnownSpeakerSuggestions(meeting, diarization);
  await writeMeeting(meeting);
  return meeting;
}

async function reconcileMeetingSpeakers(meetingId) {
  const meeting = await readMeeting(meetingId);
  meeting.speakerOverrides = meeting.speakerOverrides || {};
  const folder = path.join(MEETINGS_DIR, meetingId);
  const diarization = await readOrBuildLocalDiarization(folder, meeting);
  await hydrateSpeakerRegistryFromOverrides(meeting, diarization);
  const applied = applyMeetingLabelNearestNeighbors(meeting, diarization);
  await applyKnownSpeakerSuggestions(meeting, diarization);
  meeting.speakerLearning = {
    ...(meeting.speakerLearning || {}),
    reconciledAt: new Date().toISOString(),
    reconciledAppliedCount: applied,
    remainingUnidentifiedCount: countUnidentifiedSegments(meeting, diarization)
  };
  await writeMeeting(meeting);
  return meeting;
}

async function readSpeakerRegistry() {
  try {
    const content = await fs.readFile(SPEAKER_REGISTRY_FILE, "utf8");
    const parsed = JSON.parse(content);
    return {
      speakers: Array.isArray(parsed.speakers) ? parsed.speakers : []
    };
  } catch {
    return { speakers: [] };
  }
}

async function writeSpeakerRegistry(registry) {
  await fs.writeFile(SPEAKER_REGISTRY_FILE, JSON.stringify(registry, null, 2));
}

async function registerSpeaker(name, client, voiceprint = null, trackType = null) {
  const speakerName = cleanName(name);
  if (!speakerName) return null;
  const clientName = cleanName(client || "Unassigned");
  const registry = await readSpeakerRegistry();
  const existing = registry.speakers.find((speaker) => speaker.name.toLowerCase() === speakerName.toLowerCase());
  const now = new Date().toISOString();

  if (existing) {
    existing.clients = Array.from(new Set([...(existing.clients || []), clientName])).sort();
    existing.lastSeenAt = now;
    existing.labelCount = Number(existing.labelCount || 0) + 1;
    existing.voiceprints = mergeVoiceprints(existing.voiceprints, voiceprint, trackType);
    existing.recognition = {
      mode: "local-voiceprint-memory",
      voiceFingerprint: existing.voiceprints?.[0] || null
    };
    await writeSpeakerRegistry(registry);
    return existing;
  }

  const speaker = {
    id: slugify(speakerName),
    name: speakerName,
    aliases: [],
    clients: [clientName],
    createdAt: now,
    lastSeenAt: now,
    labelCount: 1,
    voiceprints: mergeVoiceprints([], voiceprint, trackType),
    recognition: {
      mode: "local-voiceprint-memory",
      voiceFingerprint: voiceprint
    }
  };
  registry.speakers.push(speaker);
  registry.speakers.sort((a, b) => a.name.localeCompare(b.name));
  await writeSpeakerRegistry(registry);
  return speaker;
}

function mergeVoiceprints(existing = [], voiceprint = null, trackType = null) {
  if (!Array.isArray(voiceprint) || !voiceprint.length) return existing || [];
  const prints = Array.isArray(existing) ? existing.map(normalizeStoredVoiceprint) : [];
  const candidate = { vector: voiceprint, trackType: trackType || "unknown" };
  if (!prints.length) return [candidate];
  const comparable = prints.filter((item) => !trackType || !item.trackType || item.trackType === "unknown" || item.trackType === trackType);
  const best = comparable.length ? Math.max(...comparable.map((item) => cosineSimilarity(item.vector, voiceprint))) : 0;
  if (best >= 0.96) {
    const index = prints.findIndex((item) => cosineSimilarity(item.vector, voiceprint) === best);
    prints[Math.max(0, index)] = {
      ...prints[Math.max(0, index)],
      vector: averageVectors(prints[Math.max(0, index)].vector, voiceprint),
      trackType: trackType || prints[Math.max(0, index)].trackType
    };
    return prints.slice(0, 5);
  }
  return [...prints, candidate].slice(-8);
}

function normalizeStoredVoiceprint(item) {
  if (Array.isArray(item)) return { vector: item, trackType: "unknown" };
  return {
    vector: item?.vector || [],
    trackType: item?.trackType || "unknown"
  };
}

async function writeMeeting(meeting) {
  await fs.writeFile(path.join(MEETINGS_DIR, meeting.id, "meeting.json"), JSON.stringify(meeting, null, 2));
}

async function ensureClientFolder(client) {
  const folder = path.join(CLIENTS_DIR, slugify(client || "Unassigned"));
  await fs.mkdir(path.join(folder, "notes"), { recursive: true });
  await fs.mkdir(path.join(folder, "meetings"), { recursive: true });
  const readme = path.join(folder, "README.md");
  try {
    await fs.access(readme);
  } catch {
    await fs.writeFile(readme, `# ${client}\n\nDrop prep notes, CRM exports, call notes, and relationship context in this folder.\n`);
  }
}

async function saveRecording(meetingId, buffer, contentType) {
  const meeting = await readMeeting(meetingId);
  const ext = contentType.includes("wav") ? "wav" : "webm";
  const filename = `recording.${ext}`;
  await fs.writeFile(path.join(MEETINGS_DIR, meetingId, filename), buffer);
  meeting.files.recording = filename;
  meeting.stoppedAt = new Date().toISOString();
  meeting.status = "recorded";
  await writeMeeting(meeting);
  return { filename, bytes: buffer.length, contentType };
}

async function startNativeRecording(meetingId) {
  if (!NATIVE_RECORDING_SUPPORTED) {
    throw new Error("Native macOS system audio recording is available only in local desktop mode. Cloud mode can save browser microphone recordings and use OpenAI transcription when configured.");
  }

  if (nativeRecorders.has(meetingId)) {
    return { status: "already-running" };
  }

  try {
    await fs.access(NATIVE_RECORDER);
  } catch {
    throw new Error("Native system audio recorder is not built. Run the Swift compile command from README.");
  }

  const meeting = await readMeeting(meetingId);
  const folder = path.join(MEETINGS_DIR, meetingId, "native");
  await fs.mkdir(folder, { recursive: true });
  await fs.rm(path.join(folder, "STOP"), { force: true });

  const child = spawn(NATIVE_RECORDER, [folder, "--microphone"], {
    stdio: ["ignore", "pipe", "pipe"]
  });

  const logPath = path.join(folder, "recorder.log");
  const errPath = path.join(folder, "recorder.err.log");
  child.stdout.on("data", (chunk) => fs.appendFile(logPath, chunk).catch(() => {}));
  child.stderr.on("data", (chunk) => fs.appendFile(errPath, chunk).catch(() => {}));
  child.on("exit", () => nativeRecorders.delete(meetingId));
  nativeRecorders.set(meetingId, child);

  meeting.status = "recording";
  meeting.startedAt = meeting.startedAt || new Date().toISOString();
  meeting.nativeRecorder = {
    status: "running",
    folder: "native",
    startedAt: new Date().toISOString()
  };
  await writeMeeting(meeting);

  return { status: "started", folder: "native" };
}

async function stopNativeRecording(meetingId) {
  const folder = path.join(MEETINGS_DIR, meetingId, "native");
  await fs.writeFile(path.join(folder, "STOP"), "stop");
  const child = nativeRecorders.get(meetingId);
  if (child) {
    await waitForExit(child, 5000).catch(() => {
      child.kill("SIGTERM");
    });
  }

  const meeting = await readMeeting(meetingId);
  const systemAudio = path.join(folder, "system-audio.m4a");
  const microphoneAudio = path.join(folder, "microphone-audio.m4a");
  if (await exists(systemAudio)) meeting.files.systemAudio = "native/system-audio.m4a";
  if (await exists(microphoneAudio)) meeting.files.microphoneAudio = "native/microphone-audio.m4a";
  meeting.nativeRecorder = {
    ...(meeting.nativeRecorder || {}),
    status: "stopped",
    stoppedAt: new Date().toISOString()
  };
  meeting.stoppedAt = meeting.stoppedAt || new Date().toISOString();
  await writeMeeting(meeting);

  return {
    status: "stopped",
    systemAudio: meeting.files.systemAudio,
    microphoneAudio: meeting.files.microphoneAudio
  };
}

async function getAudioClip(meetingId, searchParams) {
  const meeting = await readMeeting(meetingId);
  const folder = path.join(MEETINGS_DIR, meetingId);
  const track = String(searchParams.get("track") || "system");
  const start = Math.max(0, Number(searchParams.get("start") || 0));
  const end = Math.max(start + 0.5, Number(searchParams.get("end") || start + 8));
  const cappedEnd = Math.min(end, start + 120);
  const sourceRelative = track === "microphone" ? meeting.files.microphoneAudio : meeting.files.systemAudio;
  if (!sourceRelative) throw new Error(`No ${track} audio track is available for this meeting.`);

  const sourcePath = path.join(folder, sourceRelative);
  const clipsDir = path.join(folder, "clips");
  await fs.mkdir(clipsDir, { recursive: true });
  const clipName = `${track}-${Math.round(start * 1000)}-${Math.round(cappedEnd * 1000)}.m4a`;
  const clipPath = path.join(clipsDir, clipName);
  if (!(await exists(clipPath))) {
    await runCommand(AUDIO_CLIPPER, [
      "--input", sourcePath,
      "--output", clipPath,
      "--start", String(Math.max(0, start - 0.25)),
      "--end", String(cappedEnd + 0.25)
    ], 60 * 1000);
  }
  return { filePath: clipPath };
}

async function saveAndTranscribeChunk(meetingId, buffer, contentType) {
  const meeting = await readMeeting(meetingId);
  if (!meeting.startedAt) meeting.startedAt = new Date().toISOString();
  meeting.status = "recording";

  const chunkName = `${String(meeting.liveTranscript.length + 1).padStart(4, "0")}.webm`;
  const chunkPath = path.join(MEETINGS_DIR, meetingId, "chunks", chunkName);
  await fs.writeFile(chunkPath, buffer);

  let text = "";
  let provider = "local";
  let warning = "";

  if (TRANSCRIPTION_PROVIDER === "openai" && OPENAI_API_KEY) {
    try {
      text = await transcribeFile(chunkPath, contentType, TRANSCRIBE_MODEL);
      provider = "openai";
    } catch (error) {
      warning = error.message;
    }
  } else {
    warning = TRANSCRIPTION_PROVIDER === "local"
      ? "Local provider records backup chunks but transcribes the final native audio tracks after Stop."
      : "OPENAI_API_KEY is not set. Chunk was saved but not transcribed.";
  }

  const item = {
    at: new Date().toISOString(),
    chunk: chunkName,
    provider,
    text: text.trim(),
    warning
  };
  meeting.liveTranscript.push(item);
  await writeMeeting(meeting);
  await writeLiveTranscript(meeting);

  return item;
}

async function finalizeMeeting(meetingId) {
  const meeting = await readMeeting(meetingId);
  const folder = path.join(MEETINGS_DIR, meetingId);
  const systemAudioPath = meeting.files.systemAudio ? path.join(folder, meeting.files.systemAudio) : null;
  const browserRecordingPath = meeting.files.recording ? path.join(folder, meeting.files.recording) : null;
  const recordingPath = systemAudioPath || browserRecordingPath;

  let diarized = null;
  let transcriptText = meeting.liveTranscript.map((item) => item.text).filter(Boolean).join("\n\n");
  let warnings = [];

  if (TRANSCRIPTION_PROVIDER === "local" && recordingPath) {
    const local = await transcribeNativeTracks(folder, meeting);
    transcriptText = local.transcript || transcriptText;
    warnings.push(...local.warnings);
  } else if (recordingPath && OPENAI_API_KEY) {
    try {
      diarized = await diarizeFile(recordingPath);
      transcriptText = normalizeDiarizedTranscript(diarized) || transcriptText;
      await fs.writeFile(path.join(folder, meeting.files.diarized), JSON.stringify(diarized, null, 2));
    } catch (error) {
      warnings.push(`Speaker separation failed: ${error.message}`);
    }

    if (meeting.files.microphoneAudio) {
      try {
        const micText = await transcribeFile(path.join(folder, meeting.files.microphoneAudio), "audio/mp4", TRANSCRIBE_MODEL);
        if (micText.trim()) {
          transcriptText = [
            transcriptText,
            "",
            "## Microphone Track",
            micText.trim()
          ].join("\n");
        }
      } catch (error) {
        warnings.push(`Microphone transcription failed: ${error.message}`);
      }
    }
  } else if (!OPENAI_API_KEY) {
    warnings.push("OPENAI_API_KEY is not set. Final diarization and AI brief were skipped.");
  }

  if (!transcriptText.trim()) {
    transcriptText = "_No transcript text is available yet._";
  }

  await fs.writeFile(path.join(folder, meeting.files.transcript), transcriptText);
  diarized = await readOrBuildLocalDiarization(folder, meeting, transcriptText);
  await fs.writeFile(path.join(folder, meeting.files.diarized), JSON.stringify(diarized, null, 2));
  await hydrateSpeakerRegistryFromOverrides(meeting, diarized);
  applyKnownSpeakerSuggestions(meeting, diarized);

  let brief = buildLocalBrief(meeting, transcriptText, warnings);
  if (TRANSCRIPTION_PROVIDER === "openai" && OPENAI_API_KEY && transcriptText && !transcriptText.startsWith("_No transcript")) {
    try {
      brief = await generateBrief(meeting, transcriptText);
    } catch (error) {
      warnings.push(`AI brief failed: ${error.message}`);
      brief = buildLocalBrief(meeting, transcriptText, warnings);
    }
  }

  await fs.writeFile(path.join(folder, meeting.files.brief), brief);
  const actionPackage = await writeClientActionPackage(meeting, transcriptText);
  meeting.status = "finalized";
  meeting.stoppedAt = meeting.stoppedAt || new Date().toISOString();
  if (actionPackage) {
    meeting.files.actionPackage = "k2-action-package.json";
    meeting.files.actionPackageMarkdown = "k2-action-package.md";
  }
  meeting.transcriptText = transcriptText;
  meeting.brief = brief;
  await writeMeeting(meeting);

  return { meeting, transcript: transcriptText, brief, diarized, actionPackage, warnings };
}

async function transcribeNativeTracks(folder, meeting) {
  const warnings = [];
  const sections = [];

  if (LOCAL_TRANSCRIBE_PROVIDER !== "macos-speech") {
    if (LOCAL_TRANSCRIBE_PROVIDER !== "whisper.cpp") {
      warnings.push(`Unknown local transcription provider: ${LOCAL_TRANSCRIBE_PROVIDER}`);
      return { transcript: "", warnings };
    }
  } else {
    try {
      await fs.access(MAC_SPEECH_TRANSCRIBER);
    } catch {
      warnings.push("MacSpeechTranscriber is not built. Run the Swift compile command in README.");
      return { transcript: "", warnings };
    }
  }

  if (meeting.files.microphoneAudio) {
    try {
      const micText = await runLocalTranscriber(path.join(folder, meeting.files.microphoneAudio), "microphone");
      sections.push(`## Nathan / Local Microphone\n\n${micText || "_No speech recognized on local microphone track._"}`);
    } catch (error) {
      warnings.push(`Local mic transcription failed: ${error.message}`);
    }
  }

  if (meeting.files.systemAudio) {
    try {
      const systemText = await runLocalTranscriber(path.join(folder, meeting.files.systemAudio), "system");
      sections.push(`## Other Speaker / System Audio\n\n${systemText || "_No speech recognized on system audio track._"}`);
    } catch (error) {
      warnings.push(`System audio transcription failed: ${error.message}`);
    }
  }

  return { transcript: sections.join("\n\n"), warnings };
}

async function runLocalTranscriber(filePath, label) {
  if (LOCAL_TRANSCRIBE_PROVIDER === "whisper.cpp") {
    return runWhisper(filePath, label);
  }
  return runMacSpeech(filePath);
}

async function runWhisper(filePath, label) {
  await fs.access(WHISPER_CLI);
  await fs.access(WHISPER_MODEL);
  const absoluteFilePath = path.resolve(filePath);
  const wavPath = `${absoluteFilePath}.${label}.whisper.wav`;
  await runCommand("afconvert", [
    "-f", "WAVE",
    "-d", "LEI16@16000",
    "-c", "1",
    "--mix",
    absoluteFilePath,
    wavPath
  ], 10 * 60 * 1000);
  const result = await runCommand(WHISPER_CLI, [
    "-m", WHISPER_MODEL,
    "-f", wavPath,
    "-l", "en",
    "-t", "4"
  ], 45 * 60 * 1000);
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => /^\[\d{2}:\d{2}:\d{2}\.\d{3}\s+-->\s+\d{2}:\d{2}:\d{2}\.\d{3}\]/.test(line))
    .join("\n");
}

async function readOrBuildLocalDiarization(folder, meeting, transcriptText = meeting.transcriptText || "") {
  const diarizationPath = path.join(folder, meeting.files.diarized || "diarized.json");
  if (!transcriptText.trim()) {
    try {
      transcriptText = await fs.readFile(path.join(folder, meeting.files.transcript || "transcript.md"), "utf8");
    } catch {
      transcriptText = "";
    }
  }

  const segments = parseTranscriptSegments(transcriptText);
  const audioByTrack = {
    microphone: meeting.files.microphoneAudio ? await readWhisperWav(path.join(folder, meeting.files.microphoneAudio), "microphone") : null,
    system: meeting.files.systemAudio ? await readWhisperWav(path.join(folder, meeting.files.systemAudio), "system") : null
  };

  const withVoiceprints = segments.map((segment) => {
    const audio = audioByTrack[segment.trackType];
    return {
      ...segment,
      voiceprint: audio ? extractVoiceprint(audio, segment.startSeconds, segment.endSeconds) : null
    };
  });

  const diarization = {
    mode: "local-voiceprint-memory",
    generatedAt: new Date().toISOString(),
    threshold: VOICEPRINT_MATCH_THRESHOLD,
    segments: withVoiceprints
  };
  await fs.writeFile(diarizationPath, JSON.stringify(diarization, null, 2));
  return diarization;
}

function parseTranscriptSegments(transcriptText) {
  const segments = [];
  let currentTrack = "Transcript";
  for (const rawLine of transcriptText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const heading = line.match(/^##\s+(.+)$/);
    if (heading) {
      currentTrack = heading[1];
      continue;
    }
    const match = line.match(/^\[(\d{2}:\d{2}:\d{2})\.(\d{3})\s+-->\s+(\d{2}:\d{2}:\d{2})\.(\d{3})\]\s*(.+)$/);
    if (!match) continue;
    const text = cleanTranscriptSegmentText(match[5]);
    if (!text) continue;
    const item = {
      track: currentTrack,
      trackType: /system audio|other speaker/i.test(currentTrack) ? "system" : "microphone",
      time: match[1].replace(/^00:/, ""),
      startSeconds: timeToSecondsServer(match[1]) + Number(match[2]) / 1000,
      endSeconds: timeToSecondsServer(match[3]) + Number(match[4]) / 1000,
      text
    };
    item.key = segmentKeyServer(currentTrack, item);
    segments.push(item);
  }
  return segments;
}

function cleanTranscriptSegmentText(text) {
  const cleaned = String(text).replace(/^[-–]\s*/, "").replace(/\s+/g, " ").trim();
  if (!cleaned) return "";
  if (/^\((bell chimes|silence|music|background noise|inaudible)\)$/i.test(cleaned)) return "";
  if (/^\[(bell chimes|silence|music|background noise|inaudible)\]$/i.test(cleaned)) return "";
  return cleaned;
}

function segmentKeyServer(track, item) {
  return `${slugify(track)}:${item.time}:${hashTextServer(item.text)}`;
}

function hashTextServer(text) {
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) - hash + text.charCodeAt(index)) | 0;
  }
  return Math.abs(hash).toString(36);
}

function timeToSecondsServer(time) {
  const [hours, minutes, seconds] = time.split(":").map(Number);
  return hours * 3600 + minutes * 60 + seconds;
}

async function readWhisperWav(sourcePath, label) {
  const wavPath = `${path.resolve(sourcePath)}.${label}.whisper.wav`;
  if (!(await exists(wavPath))) return null;
  const buffer = await fs.readFile(wavPath);
  return parsePcmWav(buffer);
}

function parsePcmWav(buffer) {
  if (buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("Unsupported WAV file.");
  }
  let offset = 12;
  let fmt = null;
  let dataOffset = 0;
  let dataSize = 0;

  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (id === "fmt ") {
      fmt = {
        audioFormat: buffer.readUInt16LE(start),
        channels: buffer.readUInt16LE(start + 2),
        sampleRate: buffer.readUInt32LE(start + 4),
        bitsPerSample: buffer.readUInt16LE(start + 14)
      };
    } else if (id === "data") {
      dataOffset = start;
      dataSize = size;
      break;
    }
    offset = start + size + (size % 2);
  }

  if (!fmt || ![1, 65534].includes(fmt.audioFormat) || fmt.bitsPerSample !== 16 || !dataOffset) {
    throw new Error("Only 16-bit PCM WAV voiceprints are supported.");
  }

  return {
    buffer,
    dataOffset,
    dataSize,
    channels: fmt.channels,
    sampleRate: fmt.sampleRate
  };
}

function extractVoiceprint(audio, startSeconds, endSeconds) {
  const startFrame = Math.max(0, Math.floor(startSeconds * audio.sampleRate));
  const endFrame = Math.min(Math.floor(audio.dataSize / 2 / audio.channels), Math.ceil(endSeconds * audio.sampleRate));
  const frameCount = endFrame - startFrame;
  if (frameCount < audio.sampleRate * 0.45) return null;

  const buckets = 12;
  const features = [];
  let totalAbs = 0;
  let totalSq = 0;
  let zc = 0;
  let previous = 0;

  for (let bucket = 0; bucket < buckets; bucket += 1) {
    const bucketStart = startFrame + Math.floor((frameCount * bucket) / buckets);
    const bucketEnd = startFrame + Math.floor((frameCount * (bucket + 1)) / buckets);
    let sumSq = 0;
    let sumAbs = 0;
    let count = 0;
    for (let frame = bucketStart; frame < bucketEnd; frame += 1) {
      const sample = readMonoSample(audio, frame);
      sumSq += sample * sample;
      sumAbs += Math.abs(sample);
      if ((sample >= 0 && previous < 0) || (sample < 0 && previous >= 0)) zc += 1;
      previous = sample;
      count += 1;
    }
    const rms = Math.sqrt(sumSq / Math.max(1, count));
    features.push(Math.log10(1 + rms * 50));
    totalAbs += sumAbs;
    totalSq += sumSq;
  }

  const meanAbs = totalAbs / Math.max(1, frameCount);
  const rms = Math.sqrt(totalSq / Math.max(1, frameCount));
  features.push(Math.log10(1 + meanAbs * 50));
  features.push(Math.log10(1 + rms * 50));
  features.push(zc / Math.max(1, frameCount));
  return normalizeVector(features);
}

function readMonoSample(audio, frame) {
  let sum = 0;
  for (let channel = 0; channel < audio.channels; channel += 1) {
    const offset = audio.dataOffset + (frame * audio.channels + channel) * 2;
    if (offset + 2 > audio.buffer.length) continue;
    sum += audio.buffer.readInt16LE(offset) / 32768;
  }
  return sum / audio.channels;
}

function normalizeVector(vector) {
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (!magnitude) return vector;
  return vector.map((value) => Number((value / magnitude).toFixed(6)));
}

function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return 0;
  return a.reduce((sum, value, index) => sum + value * b[index], 0);
}

function averageVectors(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return b;
  return normalizeVector(a.map((value, index) => (value + b[index]) / 2));
}

async function applyVoiceprintLabels(meeting, diarization, speaker, labeledSegment) {
  if (!labeledSegment?.voiceprint) return 0;
  let applied = 0;
  for (const segment of diarization.segments) {
    if (segment.key === labeledSegment.key) continue;
    if (meeting.speakerOverrides[segment.key]) continue;
    if (segment.trackType !== labeledSegment.trackType) continue;
    const similarity = cosineSimilarity(labeledSegment.voiceprint, segment.voiceprint);
    if (similarity >= VOICEPRINT_MATCH_THRESHOLD) {
      meeting.speakerOverrides[segment.key] = speaker;
      applied += 1;
    }
  }
  return applied;
}

async function applyKnownSpeakerSuggestions(meeting, diarization) {
  const registry = await readSpeakerRegistry();
  meeting.speakerOverrides = meeting.speakerOverrides || {};
  meeting.speakerSuggestions = {};
  for (const segment of diarization.segments) {
    if (meeting.speakerOverrides[segment.key] || !segment.voiceprint) continue;
    const match = bestSpeakerMatch(segment.voiceprint, registry, meeting.client);
    if (match && match.score >= VOICEPRINT_MATCH_THRESHOLD) {
      meeting.speakerSuggestions[segment.key] = {
        speaker: match.speaker.name,
        confidence: Number(match.score.toFixed(3))
      };
    }
  }
}

async function hydrateSpeakerRegistryFromOverrides(meeting, diarization) {
  const overrides = meeting.speakerOverrides || {};
  for (const [key, speaker] of Object.entries(overrides)) {
    const segment = diarization.segments.find((item) => item.key === key);
    if (segment?.voiceprint) {
      await registerSpeaker(speaker, meeting.client, segment.voiceprint, segment.trackType);
    }
  }
}

function bestSpeakerMatch(voiceprint, registry, client) {
  let best = null;
  const clientName = cleanName(client || "Unassigned");
  for (const speaker of registry.speakers || []) {
    if (clientName && !(speaker.clients || []).includes(clientName)) continue;
    for (const stored of speaker.voiceprints || []) {
      const print = normalizeStoredVoiceprint(stored);
      const score = cosineSimilarity(voiceprint, print.vector);
      if (!best || score > best.score) best = { speaker, score };
    }
  }
  return best;
}

function applyMeetingLabelNearestNeighbors(meeting, diarization) {
  const labeled = diarization.segments
    .filter((segment) => meeting.speakerOverrides?.[segment.key] && segment.voiceprint)
    .map((segment) => ({
      ...segment,
      speaker: meeting.speakerOverrides[segment.key]
    }));
  let applied = 0;

  for (const segment of diarization.segments) {
    if (meeting.speakerOverrides?.[segment.key] || !segment.voiceprint) continue;
    const candidates = labeled
      .filter((item) => item.trackType === segment.trackType)
      .map((item) => ({
        speaker: item.speaker,
        score: cosineSimilarity(segment.voiceprint, item.voiceprint)
      }))
      .sort((a, b) => b.score - a.score);
    const best = candidates[0];
    const second = candidates.find((item) => item.speaker !== best?.speaker);
    if (best && best.score >= VOICEPRINT_MATCH_THRESHOLD && (!second || best.score - second.score >= 0.015)) {
      meeting.speakerOverrides[segment.key] = best.speaker;
      applied += 1;
    }
  }

  return applied;
}

function countUnidentifiedSegments(meeting, diarization) {
  return diarization.segments.filter((segment) => !meeting.speakerOverrides?.[segment.key] && !meeting.speakerSuggestions?.[segment.key]).length;
}

function runMacSpeech(filePath) {
  return new Promise((resolve, reject) => {
    const absoluteFilePath = path.resolve(filePath);
    const outputPath = `${absoluteFilePath}.transcript.txt`;
    const errorPath = `${absoluteFilePath}.transcript.err.txt`;
    const transcriberArgs = [absoluteFilePath, "--locale", LOCAL_TRANSCRIBE_LOCALE, "--output", outputPath, "--error-output", errorPath];
    if (LOCAL_TRANSCRIBE_ALLOW_NETWORK) transcriberArgs.push("--allow-network");
    const args = ["-W", "-n", MAC_SPEECH_TRANSCRIBER_APP, "--args", ...transcriberArgs];
    const child = spawn("open", args, {
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("exit", async (code, signal) => {
      try {
        const errorText = await readOptionalFile(errorPath);
        if (code !== 0 || errorText.trim()) {
          reject(new Error(errorText.trim() || stderr.trim() || `MacSpeechTranscriber exited with ${code ?? signal}`));
          return;
        }
        const outputText = await readOptionalFile(outputPath);
        resolve(outputText.trim() || stdout.trim());
      } catch (error) {
        reject(error);
      }
    });
  });
}

async function readOptionalFile(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

async function sendFile(res, filePath, contentType) {
  const data = await fs.readFile(filePath);
  res.writeHead(200, {
    "Content-Type": contentType,
    "Content-Length": data.length,
    "Cache-Control": "private, max-age=86400"
  });
  res.end(data);
}

function runCommand(command, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`${path.basename(command)} timed out.`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(stderr.trim() || `${path.basename(command)} exited with ${code ?? signal}`));
      }
    });
  });
}

async function buildPrep(input = {}) {
  const client = input.client || "";
  const query = [input.title, input.client, input.attendees, input.notes].filter(Boolean).join(" ");
  const clientFolder = path.join(CLIENTS_DIR, slugify(client || "Unassigned"));
  await ensureClientFolder(client || "Unassigned");
  const clientProfile = await findClientProfile(client);

  const files = dedupeFiles([
    ...(await collectRegistrySources(clientProfile)),
    ...(await collectTextFiles([clientFolder, INBOX_DIR], 50))
  ]);
  const scored = files
    .map((file) => ({ ...file, score: scoreText(file.content, query) }))
    .filter((file) => file.score > 0 || client)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);

  const prep = [
    `# Prep Mode: ${input.title || "Upcoming Meeting"}`,
    "",
    `Client: ${client || "Unassigned"}`,
    `Attendees: ${input.attendees || "Unknown"}`,
    "",
    "## Context Pulled",
    scored.length ? scored.map((file) => `- ${path.relative(__dirname, file.path)}${file.score ? ` (score ${file.score})` : ""}`).join("\n") : "- No matching notes found yet.",
    "",
    clientProfile?.prepChecklist?.length
      ? `## Client Checklist\n${clientProfile.prepChecklist.map((item) => `- ${item}`).join("\n")}\n`
      : "",
    clientProfile?.dashboardLinks?.length
      ? `## Linked Workspaces\n${clientProfile.dashboardLinks.map((link) => `- [${link.label}](${link.url})`).join("\n")}\n`
      : "",
    "## Talking Points",
    "- Confirm current source of truth, ownership, next actions, and follow-up rhythm.",
    "- Ask what is working today before proposing changes.",
    "- Identify the first two weeks of measurable wins.",
    "",
    "## Relevant Notes",
    scored.map((file) => `### ${path.basename(file.path)}\n\n${excerpt(file.content, 1400)}`).join("\n\n") || "_Drop notes into the client folder or data/inbox to enrich prep mode._"
  ].join("\n");

  return prep;
}

async function writeClientActionPackage(meeting, transcriptText) {
  const clientProfile = await findClientProfile(meeting.client);
  if (!clientProfile || clientProfile.id !== "k2-renew") return null;

  const packageData = buildK2ActionPackage(meeting, transcriptText);
  const folder = path.join(MEETINGS_DIR, meeting.id);
  const localJson = path.join(folder, "k2-action-package.json");
  const localMd = path.join(folder, "k2-action-package.md");
  await fs.writeFile(localJson, JSON.stringify(packageData, null, 2));
  await fs.writeFile(localMd, formatK2ActionPackage(packageData));

  if (clientProfile.meetingMonitorOutputPath) {
    await fs.writeFile(clientProfile.meetingMonitorOutputPath, JSON.stringify(packageData, null, 2));
  }

  return packageData;
}

function buildK2ActionPackage(meeting, transcriptText) {
  const lines = transcriptText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const projectMap = new Map();
  const actionWords = /\b(call|follow up|confirm|send|review|update|ask|coordinate|schedule|draft|check|verify|move|assign|add|remove|change|need|needs|owner|due|by|next action|blocker|contract|GIS|partner|landowner|term sheet|NDA)\b/i;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const ids = [...line.matchAll(/\bK2-\d+\b/gi)].map((match) => match[0].toUpperCase());
    if (!ids.length) continue;

    for (const id of ids) {
      if (!projectMap.has(id)) {
        projectMap.set(id, {
          projectId: id,
          mentions: 0,
          candidateActions: [],
          transcriptContext: []
        });
      }
      const item = projectMap.get(id);
      item.mentions += 1;
      const context = lines.slice(Math.max(0, index - 2), Math.min(lines.length, index + 3)).join(" ");
      item.transcriptContext.push(context);

      const nearby = lines.slice(index, Math.min(lines.length, index + 4)).filter((candidate) => actionWords.test(candidate));
      for (const candidate of nearby) {
        if (!item.candidateActions.includes(candidate)) item.candidateActions.push(candidate);
      }
    }
  }

  const globalActionCandidates = lines
    .filter((line) => actionWords.test(line))
    .slice(0, 80);

  return {
    type: "k2-project-development-meeting-package",
    meetingId: meeting.id,
    meetingTitle: meeting.title,
    client: meeting.client,
    createdAt: new Date().toISOString(),
    sourceTranscript: "transcript.md",
    projectActions: [...projectMap.values()],
    globalActionCandidates,
    reviewStatus: "needs-human-review",
    notes: [
      "This package is a review aid, not an automatic dashboard mutation.",
      "Use project IDs and candidate actions to update K2 meeting panels or ClickUp only after review."
    ]
  };
}

function formatK2ActionPackage(packageData) {
  const lines = [
    `# K2 Action Package: ${packageData.meetingTitle}`,
    "",
    `Meeting ID: ${packageData.meetingId}`,
    `Created: ${packageData.createdAt}`,
    `Review status: ${packageData.reviewStatus}`,
    "",
    "## Project Mentions"
  ];

  if (!packageData.projectActions.length) {
    lines.push("_No K2 project IDs were detected in the transcript._");
  }

  for (const project of packageData.projectActions) {
    lines.push("");
    lines.push(`### ${project.projectId}`);
    lines.push(`Mentions: ${project.mentions}`);
    lines.push("");
    lines.push("Candidate actions:");
    lines.push(project.candidateActions.length ? project.candidateActions.map((item) => `- ${item}`).join("\n") : "- None detected");
    lines.push("");
    lines.push("Context:");
    lines.push(project.transcriptContext.slice(0, 3).map((item) => `- ${item}`).join("\n"));
  }

  lines.push("");
  lines.push("## Global Action Candidates");
  lines.push(packageData.globalActionCandidates.length ? packageData.globalActionCandidates.map((item) => `- ${item}`).join("\n") : "_No global action candidates detected._");
  return lines.join("\n");
}

async function matchCalendar(input = {}) {
  const now = new Date(input.startTime || Date.now());
  const windowStart = new Date(now.getTime() - 90 * 60 * 1000);
  const windowEnd = new Date(now.getTime() + 4 * 60 * 60 * 1000);
  const query = [input.title, input.client, input.attendees].filter(Boolean).join(" ").toLowerCase();
  const matches = [];

  try {
    const rules = await readCalendarRules();
    const nativeEvents = cleanCalendarEvents(await readNativeCalendarEvents(1, 14), rules);
    matches.push(...nativeEvents
      .map((event) => ({
        summary: event.title,
        description: event.notes,
        start: new Date(event.start),
        end: new Date(event.end),
        calendar: event.calendar,
        location: event.location,
        attendees: event.attendees || [],
        source: "macOS Calendar",
        timezone: rules.timezone,
        score: scoreCalendarEvent(event, query)
      }))
      .filter((event) => event.start >= windowStart && event.start <= windowEnd));
  } catch (error) {
    matches.push({
      summary: "Calendar access unavailable",
      description: error.message,
      start: now,
      end: now,
      source: "macOS Calendar",
      score: -1,
      warning: true
    });
  }

  // Independent mode: import calendar exports as .ics/.txt into data/inbox.
  const files = await collectTextFiles([INBOX_DIR], 20);
  for (const file of files) {
    if (!file.path.endsWith(".ics") && !file.content.includes("BEGIN:VEVENT")) continue;
    matches.push(...parseIcsEvents(file.content)
      .filter((event) => event.start >= windowStart && event.start <= windowEnd)
      .map((event) => ({
        ...event,
        source: path.relative(__dirname, file.path),
        timezone: "America/New_York",
        score: scoreText(`${event.summary} ${event.description}`, query)
      })));
  }

  return dedupeCalendarMatches(matches)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
}

async function readCalendarRules() {
  const defaults = {
    timezone: "America/New_York",
    excludeCalendarsContaining: ["holiday", "birthdays", "birthday", "scheduled reminders", "siri suggestions"],
    excludeTitlesContaining: ["holiday", "birthday"],
    excludeAllDayEvents: true,
    excludeEventsLongerThanHours: 8,
    dedupeFields: ["title", "start", "end", "calendar", "location"]
  };
  try {
    return { ...defaults, ...JSON.parse(await fs.readFile(CALENDAR_RULES_FILE, "utf8")) };
  } catch {
    return defaults;
  }
}

function cleanCalendarEvents(events, rules) {
  const seen = new Set();
  return events.filter((event) => {
    const calendar = String(event.calendar || "").toLowerCase();
    const title = String(event.title || "").toLowerCase();
    if ((rules.excludeCalendarsContaining || []).some((needle) => calendar.includes(String(needle).toLowerCase()))) return false;
    if ((rules.excludeTitlesContaining || []).some((needle) => title.includes(String(needle).toLowerCase()))) return false;

    const start = new Date(event.start);
    const end = new Date(event.end);
    const durationHours = (end.getTime() - start.getTime()) / 36e5;
    if (rules.excludeAllDayEvents && isAllDayLike(start, end)) return false;
    if (rules.excludeEventsLongerThanHours && durationHours > rules.excludeEventsLongerThanHours) return false;

    const key = (rules.dedupeFields || ["title", "start", "end"]).map((field) => normalizeCalendarKey(event[field])).join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function dedupeCalendarMatches(matches) {
  const seen = new Set();
  return matches.filter((event) => {
    if (event.warning) return true;
    const key = [
      normalizeCalendarKey(event.summary),
      new Date(event.start).toISOString(),
      new Date(event.end).toISOString(),
      normalizeCalendarKey(event.calendar),
      normalizeCalendarKey(event.location)
    ].join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isAllDayLike(start, end) {
  const durationHours = (end.getTime() - start.getTime()) / 36e5;
  return durationHours >= 23 && start.getUTCHours() === 4 && end.getUTCHours() === 3;
}

function normalizeCalendarKey(value = "") {
  return String(value).toLowerCase().replace(/\s+/g, " ").trim();
}

function readNativeCalendarEvents(daysBack, daysForward) {
  return new Promise(async (resolve, reject) => {
    if (!NATIVE_RECORDING_SUPPORTED) {
      reject(new Error("macOS Calendar matching is available only in local desktop mode."));
      return;
    }

    try {
      await fs.access(CALENDAR_READER);
    } catch {
      reject(new Error("CalendarReader is not built. Rebuild the native calendar helper."));
      return;
    }

    const child = spawn(CALENDAR_READER, ["--days-back", String(daysBack), "--days-forward", String(daysForward)], {
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("exit", (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `CalendarReader exited with ${code}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout || "[]"));
      } catch (error) {
        reject(error);
      }
    });
  });
}

async function transcribeFile(filePath, contentType, model) {
  const form = new FormData();
  const data = await fs.readFile(filePath);
  form.append("file", new Blob([data], { type: contentType || "audio/webm" }), path.basename(filePath));
  form.append("model", model);
  form.append("response_format", "text");

  const result = await openaiFetch("https://api.openai.com/v1/audio/transcriptions", form);
  return typeof result === "string" ? result : result.text || "";
}

async function diarizeFile(filePath) {
  const form = new FormData();
  const data = await fs.readFile(filePath);
  const type = filePath.endsWith(".wav") ? "audio/wav" : "audio/webm";
  form.append("file", new Blob([data], { type }), path.basename(filePath));
  form.append("model", DIARIZE_MODEL);
  form.append("response_format", "diarized_json");
  form.append("chunking_strategy", "auto");

  return openaiFetch("https://api.openai.com/v1/audio/transcriptions", form);
}

async function generateBrief(meeting, transcript) {
  const prompt = `Create a concise but useful meeting brief for Nathan.

Meeting:
- Title: ${meeting.title}
- Client: ${meeting.client}
- Attendees: ${meeting.attendees || "Unknown"}
- Platform: ${meeting.platform}

Transcript:
${transcript}

Return Markdown with:
1. Executive Summary
2. Decisions
3. Action Items with owner/date when known
4. Buying Signals or Risks
5. Open Questions
6. Follow-up Message Draft`;

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: SUMMARY_MODEL,
      input: prompt
    })
  });

  if (!response.ok) {
    throw new Error(`OpenAI brief request failed: HTTP ${response.status} ${await response.text()}`);
  }

  const json = await response.json();
  return json.output_text || json.output?.flatMap((item) => item.content || []).map((part) => part.text).filter(Boolean).join("\n") || "";
}

async function openaiFetch(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
    body
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`OpenAI request failed: HTTP ${response.status} ${text}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function normalizeDiarizedTranscript(payload) {
  const segments = payload?.segments || payload?.text?.segments || [];
  if (!Array.isArray(segments) || !segments.length) return payload?.text || "";
  return segments.map((segment) => {
    const speaker = segment.speaker || segment.speaker_label || "Speaker";
    const start = typeof segment.start === "number" ? formatTime(segment.start) : "";
    return `**${speaker}${start ? ` ${start}` : ""}:** ${segment.text || ""}`.trim();
  }).join("\n\n");
}

async function writeLiveTranscript(meeting) {
  const text = meeting.liveTranscript
    .filter((item) => item.text)
    .map((item) => `### ${item.at}\n\n${item.text}`)
    .join("\n\n");
  await fs.writeFile(path.join(MEETINGS_DIR, meeting.id, "recording-events.md"), text || "_No recording events yet._");
}

function buildLocalBrief(meeting, transcript, warnings = []) {
  return [
    `# Meeting Brief: ${meeting.title}`,
    "",
    `Client: ${meeting.client}`,
    `Attendees: ${meeting.attendees || "Unknown"}`,
    `Status: ${meeting.status}`,
    "",
    warnings.length ? `## Warnings\n${warnings.map((warning) => `- ${warning}`).join("\n")}\n` : "",
    "## Executive Summary",
    "AI summary not generated. Review the transcript below and run Finalize again after setting `OPENAI_API_KEY`.",
    "",
    "## Action Items",
    "- Review transcript and extract follow-ups.",
    "",
    "## Transcript",
    transcript
  ].filter(Boolean).join("\n");
}

async function collectTextFiles(roots, limit) {
  const files = [];
  for (const root of roots) {
    await walk(root, files, limit);
  }
  return files;
}

async function readClientRegistry() {
  try {
    const content = await fs.readFile(CLIENT_REGISTRY_FILE, "utf8");
    const registry = JSON.parse(content);
    return { clients: Array.isArray(registry.clients) ? registry.clients : [] };
  } catch {
    return { clients: [] };
  }
}

async function findClientProfile(clientName) {
  const registry = await readClientRegistry();
  const normalized = normalizeName(clientName);
  return registry.clients.find((client) => {
    const names = [client.name, client.id, ...(client.aliases || [])].map(normalizeName);
    return names.includes(normalized);
  }) || null;
}

async function collectRegistrySources(clientProfile) {
  if (!clientProfile?.prepSources?.length) return [];
  const files = [];
  for (const source of clientProfile.prepSources) {
    if (source.type === "folder") {
      const collected = [];
      await walkRegistryFolder(source.path, collected, source.maxFiles || 20, source.maxBytes || 100000);
      files.push(...collected.map((file) => ({ ...file, label: source.label || file.path })));
    } else if (source.type === "file") {
      const content = await readSourceFile(source.path, source.maxBytes || 120000, source.patterns);
      if (content) files.push({ path: source.path, label: source.label || source.path, content });
    }
  }
  return files;
}

async function walkRegistryFolder(dir, files, limit, maxBytes) {
  if (files.length >= limit) return;
  let entries = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkRegistryFolder(fullPath, files, limit, maxBytes);
    } else if (/\.(md|txt|json|csv|ics)$/i.test(entry.name)) {
      const content = await readSourceFile(fullPath, maxBytes);
      if (content) files.push({ path: fullPath, content });
    }
    if (files.length >= limit) return;
  }
}

async function readSourceFile(filePath, maxBytes, patterns = []) {
  try {
    const handle = await fs.open(filePath, "r");
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    await handle.close();
    let content = buffer.subarray(0, bytesRead).toString("utf8");
    if (patterns?.length) {
      const lines = content.split(/\r?\n/);
      const selected = [];
      for (let index = 0; index < lines.length; index += 1) {
        if (patterns.some((pattern) => lines[index].includes(pattern))) {
          selected.push(lines.slice(Math.max(0, index - 3), Math.min(lines.length, index + 6)).join("\n"));
        }
      }
      content = selected.join("\n\n---\n\n") || content.slice(0, maxBytes);
    }
    return content;
  } catch {
    return "";
  }
}

async function walk(dir, files, limit) {
  if (files.length >= limit) return;
  let entries = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(fullPath, files, limit);
    } else if (/\.(md|txt|json|csv|ics)$/i.test(entry.name)) {
      try {
        const content = await fs.readFile(fullPath, "utf8");
        files.push({ path: fullPath, content });
      } catch {
        // Ignore binary or unreadable files.
      }
    }
    if (files.length >= limit) return;
  }
}

function parseIcsEvents(content) {
  const blocks = content.split("BEGIN:VEVENT").slice(1).map((block) => block.split("END:VEVENT")[0]);
  return blocks.map((block) => {
    const get = (key) => {
      const line = block.split(/\r?\n/).find((item) => item.startsWith(key));
      return line ? line.split(":").slice(1).join(":").replace(/\\n/g, " ").trim() : "";
    };
    return {
      summary: get("SUMMARY"),
      description: get("DESCRIPTION"),
      start: parseIcsDate(get("DTSTART")),
      end: parseIcsDate(get("DTEND"))
    };
  }).filter((event) => event.summary && !Number.isNaN(event.start.getTime()));
}

function parseIcsDate(value) {
  const raw = value.replace(/Z$/, "");
  if (!raw) return new Date(NaN);
  const match = raw.match(/^(\d{4})(\d{2})(\d{2})T?(\d{2})?(\d{2})?(\d{2})?/);
  if (!match) return new Date(NaN);
  const [, year, month, day, hour = "00", minute = "00", second = "00"] = match;
  return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second)));
}

function scoreText(content = "", query = "") {
  const haystack = content.toLowerCase();
  const terms = query.toLowerCase().split(/\W+/).filter((term) => term.length > 2);
  return terms.reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0);
}

function scoreCalendarEvent(event, query = "") {
  const content = [
    event.title,
    event.notes,
    event.calendar,
    event.location,
    ...(event.attendees || [])
  ].join(" ");
  return scoreText(content, query);
}

function normalizeName(value = "") {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function excerpt(content, max) {
  const clean = content.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max)}...` : clean;
}

function dedupeFiles(files) {
  const seen = new Set();
  return files.filter((file) => {
    const key = file.path;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function cleanName(value) {
  return String(value || "").trim() || "Unassigned";
}

function slugify(value) {
  return cleanName(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "untitled";
}

function dateStamp(date) {
  return date.toISOString().slice(0, 10);
}

function formatTime(seconds) {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

async function readJson(req) {
  const buffer = await readBuffer(req);
  return buffer.length ? JSON.parse(buffer.toString("utf8")) : {};
}

function readBuffer(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function waitForExit(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Native recorder did not stop in time.")), timeoutMs);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function sendJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload, null, 2));
}
