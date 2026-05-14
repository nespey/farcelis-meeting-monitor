const state = {
  meeting: null,
  stream: null,
  recorder: null,
  chunks: [],
  startedAt: null,
  timer: null,
  chunkIndex: 0,
  transcriptText: "",
  transcriptView: "clean",
  speakerOverrides: {},
  speakerSuggestions: {},
  knownSpeakers: [],
  speakerEditor: null,
  clipAudio: null,
  nativeRecordingSupported: true,
  storageMode: "local-filesystem"
};

const DISPLAY_TIME_ZONE = "America/New_York";

const $ = (selector) => document.querySelector(selector);

const form = $("#meeting-form");
const startButton = $("#start-button");
const stopButton = $("#stop-button");
const finalizeButton = $("#finalize-button");
const recordingOutput = $("#recording-output");
const transcriptOutput = $("#transcript-output");
const briefOutput = $("#brief-output");
const prepOutput = $("#prep-output");
const fileOutput = $("#file-output");

init();

async function init() {
  bindTabs();
  bindControls();
  applyUrlPreset();
  await loadStatus();
  await loadMeetings();
}

function bindTabs() {
  document.querySelectorAll(".tabs button").forEach((button) => {
    button.addEventListener("click", () => {
      document.querySelectorAll(".tabs button").forEach((item) => item.classList.remove("active"));
      document.querySelectorAll(".tab-panel").forEach((item) => item.classList.remove("active"));
      button.classList.add("active");
      $(`#${button.dataset.tab}-tab`).classList.add("active");
    });
  });
}

function bindControls() {
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    await startMeeting();
  });

  stopButton.addEventListener("click", stopMeeting);
  finalizeButton.addEventListener("click", finalizeMeeting);
  $("#refresh-meetings").addEventListener("click", loadMeetings);
  $("#prep-button").addEventListener("click", runPrepMode);
  $("#calendar-button").addEventListener("click", runCalendarMatch);
  $("#k2-preset-button").addEventListener("click", loadK2Preset);
  $("#clear-preset-button").addEventListener("click", clearPreset);
  $("#clean-transcript-button").addEventListener("click", () => setTranscriptView("clean"));
  $("#raw-transcript-button").addEventListener("click", () => setTranscriptView("raw"));
  $("#reconcile-speakers-button").addEventListener("click", reconcileSpeakers);
  $("#next-review-button").addEventListener("click", jumpToNextReview);
  transcriptOutput.addEventListener("click", handleTranscriptClick);
  transcriptOutput.addEventListener("dblclick", handleTranscriptDoubleClick);
  $("#speaker-select").addEventListener("change", handleSpeakerSelectChange);
  $("#speaker-save-button").addEventListener("click", saveSpeakerEditor);
  $("#speaker-clear-button").addEventListener("click", clearSpeakerEditor);
  $("#speaker-cancel-button").addEventListener("click", closeSpeakerEditor);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeSpeakerEditor();
  });
}

async function loadStatus() {
  const status = await api("/api/status");
  const pill = $("#api-status");
  const isLocal = status.transcriptionProvider === "local";
  state.nativeRecordingSupported = Boolean(status.nativeRecordingSupported);
  state.storageMode = status.storageMode || "local-filesystem";
  pill.textContent = state.storageMode === "ephemeral-cloud"
    ? "Cloud monitor"
    : (isLocal ? "Local transcription" : (status.openaiConfigured ? "OpenAI ready" : "Local capture only"));
  pill.classList.toggle("ready", isLocal || status.openaiConfigured);
  pill.classList.toggle("local", !status.openaiConfigured || isLocal);
  pill.title = `Provider: ${status.transcriptionProvider}\nLocal: ${status.localTranscribeProvider}\nNative recording: ${state.nativeRecordingSupported ? "available" : "cloud disabled"}\nStorage: ${state.storageMode}\nDiarize: ${status.models.diarize}\nSummary: ${status.models.summary}`;
  if (!state.nativeRecordingSupported) {
    setNativeStatus("Cloud mode is live. Native macOS system audio and Calendar access stay in the local desktop app; browser microphone capture and OpenAI finalization can run here when configured.", "ready");
  }
}

async function loadMeetings() {
  const { meetings } = await api("/api/meetings");
  const list = $("#meeting-list");
  list.innerHTML = meetings.length ? "" : '<div class="empty-state">No meetings yet.</div>';
  meetings.forEach((meeting) => {
    const card = document.createElement("button");
    card.className = "meeting-card";
    card.type = "button";
    card.innerHTML = `
      <strong>${escapeHtml(meeting.title)}</strong>
      <span>${escapeHtml(meeting.client)} · ${escapeHtml(meeting.status)}</span>
      <span>${formatEastern(meeting.createdAt)} ET</span>
    `;
    card.addEventListener("click", () => loadMeeting(meeting.id));
    list.appendChild(card);
  });
}

async function loadMeeting(id) {
  const { meeting } = await api(`/api/meetings/${id}`);
  state.meeting = meeting;
  state.transcriptText = meeting.transcriptText || "";
  state.speakerOverrides = meeting.speakerOverrides || {};
  state.speakerSuggestions = meeting.speakerSuggestions || {};
  await loadKnownSpeakers(meeting.client);
  renderMeetingFiles(meeting);
  renderRecordingEvents(meeting.liveTranscript || []);
  renderTranscript();
  briefOutput.textContent = meeting.brief || "Finalize a meeting to generate the brief.";
  finalizeButton.disabled = !meeting.files?.recording && !meeting.files?.systemAudio && !(meeting.liveTranscript || []).length;
}

async function loadKnownSpeakers(client) {
  try {
    const params = new URLSearchParams({ client: client || "" });
    const result = await api(`/api/speakers?${params.toString()}`);
    state.knownSpeakers = result.speakers || [];
  } catch {
    state.knownSpeakers = [];
  }
}

async function startMeeting() {
  if (!$("#consent").checked) {
    alert("Confirm consent before recording. A simple verbal disclosure at the start of the call is usually the cleanest move.");
    return;
  }

  const payload = getMeetingPayload();
  const created = await api("/api/meetings", {
    method: "POST",
    body: JSON.stringify(payload)
  });
  state.meeting = created.meeting;
  state.chunks = [];
  state.chunkIndex = 0;

  if (state.nativeRecordingSupported) {
    await startNativeSystemAudio();
  } else {
    setNativeStatus("Cloud mode recording started. This browser can save microphone audio; native system audio is local-only.", "ready");
  }

  try {
    state.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    });
  } catch (error) {
    setNativeStatus("Native system audio is running. Browser mic capture was not granted, so the app will still capture the other speaker but may miss your local mic track.", "ready");
    state.stream = null;
  }

  if (state.stream) {
    const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? "audio/webm;codecs=opus"
      : "audio/webm";

    state.recorder = new MediaRecorder(state.stream, { mimeType });
    state.recorder.addEventListener("dataavailable", handleChunk);
    state.recorder.addEventListener("stop", saveFinalRecording);
    state.recorder.start(15000);
  }

  state.startedAt = Date.now();
  state.timer = setInterval(updateTimer, 1000);
  startButton.disabled = true;
  stopButton.disabled = false;
  finalizeButton.disabled = true;
  recordingOutput.innerHTML = state.nativeRecordingSupported
    ? '<div class="empty-state">Recording started. Keep this running through the call. Native system audio is the primary track; final transcript is created after Stop/Finalize.</div>'
    : '<div class="empty-state">Cloud recording started. Keep this tab open; browser microphone audio will be saved for finalization.</div>';
  renderMeetingFiles(state.meeting);
}

async function startNativeSystemAudio() {
  try {
    const result = await api(`/api/meetings/${state.meeting.id}/native-start`, { method: "POST" });
    setNativeStatus(`System audio recorder ${result.status}. The other speaker is being captured through macOS ScreenCaptureKit.`, "ready");
  } catch (error) {
    setNativeStatus(`System audio recorder failed: ${error.message}`, "error");
    throw error;
  }
}

async function handleChunk(event) {
  if (!event.data || !event.data.size || !state.meeting) return;
  state.chunks.push(event.data);
  state.chunkIndex += 1;
  const item = document.createElement("div");
  item.className = "transcript-line";
  item.innerHTML = `<time>${new Date().toLocaleTimeString()}</time><div>Saved browser backup audio chunk ${state.chunkIndex}.</div>`;
  clearEmptyRecording();
  recordingOutput.prepend(item);

  try {
    const result = await fetch(`/api/meetings/${state.meeting.id}/chunk`, {
      method: "POST",
      headers: { "Content-Type": event.data.type || "audio/webm" },
      body: event.data
    }).then((response) => response.json());

    item.innerHTML = result.text
      ? formatTranscriptLine(result)
      : `<time>${new Date(result.at || Date.now()).toLocaleTimeString()}</time><div>${escapeHtml(result.warning || `Saved browser backup audio chunk ${state.chunkIndex}.`)}</div>`;
  } catch (error) {
    item.innerHTML = `<time>${new Date().toLocaleTimeString()}</time><div class="warning">${escapeHtml(error.message)}</div>`;
  }
}

function stopMeeting() {
  if (state.recorder && state.recorder.state !== "inactive") {
    state.recorder.stop();
  } else {
    stopNativeOnly();
  }
  state.stream?.getTracks().forEach((track) => track.stop());
  clearInterval(state.timer);
  updateTimer();
  stopButton.disabled = true;
}

async function saveFinalRecording() {
  await stopNativeOnly();
  const blob = new Blob(state.chunks, { type: state.recorder.mimeType || "audio/webm" });
  await fetch(`/api/meetings/${state.meeting.id}/recording`, {
    method: "POST",
    headers: { "Content-Type": blob.type },
    body: blob
  });

  startButton.disabled = false;
  finalizeButton.disabled = false;
  await loadMeeting(state.meeting.id);
  await loadMeetings();
}

async function stopNativeOnly() {
  if (!state.meeting) return;
  try {
    const result = await api(`/api/meetings/${state.meeting.id}/native-stop`, { method: "POST" });
    setNativeStatus(`System audio saved: ${result.systemAudio || "not found yet"}. Mic track: ${result.microphoneAudio || "not found"}.`, "ready");
  } catch (error) {
    setNativeStatus(`System audio stop warning: ${error.message}`, "error");
  }
}

async function finalizeMeeting() {
  if (!state.meeting) return;
  finalizeButton.disabled = true;
  const originalLabel = finalizeButton.textContent;
  finalizeButton.textContent = "Finalizing...";
  setNativeStatus("Finalizing transcript from saved audio. Long meetings can take several minutes.", "ready");
  briefOutput.textContent = "Finalizing transcript, speaker separation, and brief...";
  transcriptOutput.textContent = "Finalizing local transcript from saved microphone and system audio tracks...";
  showTab("transcript");
  try {
    const result = await api(`/api/meetings/${state.meeting.id}/finalize`, { method: "POST" });
    state.meeting = result.meeting;
    state.transcriptText = result.transcript || "";
    state.speakerOverrides = result.meeting.speakerOverrides || {};
    state.speakerSuggestions = result.meeting.speakerSuggestions || {};
    const warningText = Array.isArray(result.warnings) && result.warnings.length
      ? ["# Finalize Warnings", "", ...result.warnings.map((warning) => `- ${warning}`), ""].join("\n")
      : "";
    briefOutput.textContent = [warningText, result.brief || "No brief generated."].filter(Boolean).join("\n");
    renderTranscript(warningText);
    renderMeetingFiles(result.meeting);
    setNativeStatus("Finalize complete. Transcript and brief files were updated.", "ready");
    await loadMeetings();
  } catch (error) {
    transcriptOutput.textContent = `Finalize failed: ${error.message}`;
    setNativeStatus(`Finalize failed: ${error.message}`, "error");
  } finally {
    finalizeButton.textContent = originalLabel;
    finalizeButton.disabled = false;
  }
}

function setTranscriptView(view) {
  state.transcriptView = view;
  $("#clean-transcript-button").classList.toggle("active", view === "clean");
  $("#raw-transcript-button").classList.toggle("active", view === "raw");
  renderTranscript();
}

function renderTranscript(prefix = "") {
  const transcript = state.transcriptText || "";
  transcriptOutput.classList.toggle("transcript-clean", state.transcriptView === "clean");
  transcriptOutput.classList.toggle("transcript-raw", state.transcriptView === "raw");

  if (!transcript.trim()) {
    transcriptOutput.textContent = "Finalize a meeting to create the transcript.";
    updateReviewButton([]);
    return;
  }

  if (state.transcriptView === "raw") {
    transcriptOutput.textContent = [prefix, transcript].filter(Boolean).join("\n");
    updateReviewButton([]);
    return;
  }

  transcriptOutput.innerHTML = [
    prefix ? `<div class="transcript-warning">${escapeHtml(prefix)}</div>` : "",
    ...formatCleanTranscript(transcript)
  ].filter(Boolean).join("");
  updateReviewButton([...transcriptOutput.querySelectorAll(".needs-review")]);
}

function formatCleanTranscript(text) {
  const lines = text.split(/\r?\n/);
  const sections = [];
  let current = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const heading = trimmed.match(/^##\s+(.+)$/);
    if (heading) {
      current = { speaker: heading[1], items: [] };
      sections.push(current);
      continue;
    }

    const item = parseTranscriptLine(trimmed);
    if (!item) continue;
    if (!current) {
      current = { speaker: "Transcript", items: [] };
      sections.push(current);
    }
    current.items.push(item);
  }

  const timeline = mergeSpeakerTurns(sections
    .flatMap((section) => collapseTranscriptItems(section.items).map((item) => ({
      ...item,
      trackSpeaker: labelTranscriptSection(section.speaker),
      trackType: /system audio|other speaker/i.test(section.speaker) ? "system" : "microphone",
      key: segmentKey(section.speaker, item)
    })))
    .map((item) => ({
      ...item,
      suggestedSpeaker: state.speakerSuggestions[item.key]?.speaker || "",
      suggestedConfidence: state.speakerSuggestions[item.key]?.confidence || 0,
      speaker: state.speakerOverrides[item.key] || state.speakerSuggestions[item.key]?.speaker || item.trackSpeaker,
      isSuggestion: !state.speakerOverrides[item.key] && Boolean(state.speakerSuggestions[item.key]?.speaker),
      needsReview: !state.speakerOverrides[item.key]
    }))
    .sort((a, b) => a.seconds - b.seconds || speakerOrder(a.speaker) - speakerOrder(b.speaker)));

  if (!timeline.length) {
    return ['<div class="empty-state">No usable speech found in this transcript.</div>'];
  }

  return [`
    <section class="transcript-section">
      <h3>Conversation Timeline</h3>
      ${timeline.map((item) => `
        <article class="transcript-item ${speakerSideClass(item.speaker)} ${item.needsReview ? "needs-review" : ""}" style="--speaker-color: ${speakerColor(item.speaker)};" data-track="${escapeHtml(item.trackType)}" data-start="${escapeHtml(String(item.seconds))}" data-end="${escapeHtml(String(item.endSeconds))}" title="Double-click to hear this audio clip">
          <div>
            <div class="message-meta">
              <button class="speaker-badge ${item.isSuggestion ? "speaker-suggestion" : ""}" type="button" data-segment-key="${escapeHtml(item.key)}" data-segment-keys="${escapeHtml(item.keys.join(","))}" data-current-speaker="${escapeHtml(item.speaker)}" title="Click to identify this speaker">${escapeHtml(item.speaker)}${item.isSuggestion ? `? ${escapeHtml(String(item.suggestedConfidence))}` : ""}</button>
              <time>${escapeHtml(item.time)}</time>
            </div>
            <p>${escapeHtml(item.text)}</p>
          </div>
        </article>
      `).join("")}
    </section>
  `];
}

function labelTranscriptSection(speaker) {
  if (/system audio|other speaker/i.test(speaker)) return "Meeting Audio";
  if (/local microphone|nathan/i.test(speaker)) return "Nathan";
  return speaker;
}

function speakerOrder(speaker) {
  return speaker === "Nathan" ? 0 : 1;
}

function speakerSideClass(speaker) {
  if (/^Nathan($| )|Nathan Espey/i.test(speaker)) return "speaker-side-right";
  if (speaker === "Meeting Audio") return "speaker-side-left";
  const sides = ["speaker-side-left", "speaker-side-mid"];
  return sides[hashNumber(speaker) % sides.length];
}

function speakerColor(speaker) {
  if (/^Nathan($| )|Nathan Espey/i.test(speaker)) return "#ef4444";
  if (speaker === "Meeting Audio") return "#58c4ad";
  const colors = ["#f59e0b", "#22c55e", "#38bdf8", "#a78bfa", "#f472b6", "#14b8a6", "#eab308", "#fb7185"];
  return colors[hashNumber(speaker) % colors.length];
}

function mergeSpeakerTurns(items) {
  const turns = [];
  for (const item of items) {
    const previous = turns[turns.length - 1];
    if (previous && previous.speaker === item.speaker && previous.isSuggestion === item.isSuggestion && previous.needsReview === item.needsReview) {
      previous.text = `${previous.text} ${item.text}`.replace(/\s+/g, " ").trim();
      previous.endSeconds = item.endSeconds;
      previous.endTime = item.endTime;
      previous.trackType = item.trackType;
      previous.needsReview = previous.needsReview || item.needsReview;
      previous.keys.push(item.key);
      continue;
    }
    turns.push({
      ...item,
      keys: [item.key]
    });
  }
  return turns.map((turn) => ({
    ...turn,
    key: turn.keys[0],
    time: turn.endTime && turn.endTime !== turn.time ? `${turn.time}-${turn.endTime}` : turn.time
  }));
}

function updateReviewButton(items) {
  const button = $("#next-review-button");
  if (!button) return;
  const count = items.length;
  button.disabled = count === 0;
  button.textContent = count ? `Review: ${count}` : "Review: 0";
}

function jumpToNextReview() {
  const items = [...transcriptOutput.querySelectorAll(".needs-review")];
  if (!items.length) {
    updateReviewButton([]);
    return;
  }
  const currentIndex = items.findIndex((item) => item.classList.contains("review-focus"));
  items.forEach((item) => item.classList.remove("review-focus"));
  const next = items[(currentIndex + 1) % items.length];
  next.classList.add("review-focus");
  next.scrollIntoView({ behavior: "smooth", block: "center" });
}

function hashNumber(value) {
  let hash = 0;
  for (let index = 0; index < String(value).length; index += 1) {
    hash = ((hash << 5) - hash + String(value).charCodeAt(index)) | 0;
  }
  return Math.abs(hash);
}

function handleTranscriptClick(event) {
  const badge = event.target.closest("[data-segment-key]");
  if (!badge || !state.meeting) return;
  openSpeakerEditor(badge);
}

async function handleTranscriptDoubleClick(event) {
  const item = event.target.closest(".transcript-item");
  if (!item || !state.meeting) return;
  event.preventDefault();
  const params = new URLSearchParams({
    track: item.dataset.track || "system",
    start: item.dataset.start || "0",
    end: item.dataset.end || "8"
  });
  item.classList.add("playing");
  setNativeStatus("Playing transcript audio clip.", "ready");
  try {
    if (state.clipAudio) {
      state.clipAudio.pause();
      URL.revokeObjectURL(state.clipAudio.src);
    }
    const response = await fetch(`/api/meetings/${state.meeting.id}/audio-clip?${params.toString()}`);
    if (!response.ok) throw new Error((await response.json()).error || "Audio clip failed.");
    const blob = await response.blob();
    const audio = new Audio(URL.createObjectURL(blob));
    state.clipAudio = audio;
    audio.addEventListener("ended", () => item.classList.remove("playing"), { once: true });
    await audio.play();
  } catch (error) {
    item.classList.remove("playing");
    setNativeStatus(`Audio clip failed: ${error.message}`, "error");
  }
}

function openSpeakerEditor(badge) {
  const popover = $("#speaker-popover");
  const select = $("#speaker-select");
  const input = $("#speaker-name-input");
  const currentSpeaker = badge.dataset.currentSpeaker || "";
  state.speakerEditor = {
    key: badge.dataset.segmentKey,
    keys: (badge.dataset.segmentKeys || badge.dataset.segmentKey || "").split(",").filter(Boolean),
    currentSpeaker
  };

  const speakerNames = Array.from(new Set([
    currentSpeaker,
    ...state.knownSpeakers.map((speaker) => speaker.name),
    "Nathan Espey"
  ].filter(Boolean))).sort((a, b) => a.localeCompare(b));

  select.innerHTML = [
    '<option value="">Custom / unnamed</option>',
    ...speakerNames.map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`)
  ].join("");
  select.value = speakerNames.includes(currentSpeaker) ? currentSpeaker : "";
  input.value = currentSpeaker === "Meeting Audio" ? "" : currentSpeaker;

  const rect = badge.getBoundingClientRect();
  popover.hidden = false;
  popover.style.top = `${Math.min(window.innerHeight - 260, rect.bottom + 8)}px`;
  popover.style.left = `${Math.min(window.innerWidth - 340, Math.max(16, rect.left))}px`;
  input.focus();
  input.select();
}

function handleSpeakerSelectChange() {
  const value = $("#speaker-select").value;
  if (value) $("#speaker-name-input").value = value;
}

async function saveSpeakerEditor() {
  const speaker = $("#speaker-name-input").value.trim() || $("#speaker-select").value.trim();
  await saveSpeakerLabel(speaker);
}

async function clearSpeakerEditor() {
  await saveSpeakerLabel("");
}

async function saveSpeakerLabel(speaker) {
  if (!state.speakerEditor || !state.meeting) return;
  try {
    const result = await api(`/api/meetings/${state.meeting.id}/speaker-overrides`, {
      method: "POST",
      body: JSON.stringify({ key: state.speakerEditor.key, keys: state.speakerEditor.keys, speaker })
    });
    state.meeting = result.meeting;
    state.speakerOverrides = result.meeting.speakerOverrides || {};
    state.speakerSuggestions = result.meeting.speakerSuggestions || {};
    await loadKnownSpeakers(result.meeting.client);
    closeSpeakerEditor();
    renderTranscript();
  } catch (error) {
    setNativeStatus(`Speaker label failed: ${error.message}`, "error");
  }
}

async function reconcileSpeakers() {
  if (!state.meeting) return;
  const button = $("#reconcile-speakers-button");
  button.disabled = true;
  button.textContent = "Matching...";
  setNativeStatus("Re-running speaker matching across the full transcript.", "ready");
  try {
    const result = await api(`/api/meetings/${state.meeting.id}/speaker-reconcile`, { method: "POST" });
    state.meeting = result.meeting;
    state.speakerOverrides = result.meeting.speakerOverrides || {};
    state.speakerSuggestions = result.meeting.speakerSuggestions || {};
    await loadKnownSpeakers(result.meeting.client);
    renderTranscript();
    const remaining = result.meeting.speakerLearning?.remainingUnidentifiedCount;
    setNativeStatus(`Speaker match complete. ${remaining ?? 0} clips still need review.`, "ready");
  } catch (error) {
    setNativeStatus(`Speaker match failed: ${error.message}`, "error");
  } finally {
    button.disabled = false;
    button.textContent = "Re-run Speaker Match";
  }
}

function closeSpeakerEditor() {
  const popover = $("#speaker-popover");
  if (popover) popover.hidden = true;
  state.speakerEditor = null;
}

function segmentKey(track, item) {
  return `${slugifyLocal(track)}:${item.time}:${hashText(item.text)}`;
}

function hashText(text) {
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) - hash + text.charCodeAt(index)) | 0;
  }
  return Math.abs(hash).toString(36);
}

function slugifyLocal(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "track";
}

function parseTranscriptLine(line) {
  const match = line.match(/^\[(\d{2}:\d{2}:\d{2})\.\d{3}\s+-->\s+(\d{2}:\d{2}:\d{2})\.\d{3}\]\s*(.+)$/);
  if (!match) return null;
  const text = cleanTranscriptText(match[3]);
  if (!text) return null;
  return {
    time: match[1].replace(/^00:/, ""),
    endTime: match[2].replace(/^00:/, ""),
    seconds: timeToSeconds(match[1]),
    endSeconds: timeToSeconds(match[2]),
    text
  };
}

function timeToSeconds(time) {
  const [hours, minutes, seconds] = time.split(":").map(Number);
  return hours * 3600 + minutes * 60 + seconds;
}

function cleanTranscriptText(text) {
  const cleaned = text
    .replace(/^[-–]\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "";
  if (/^\((bell chimes|silence|music|background noise|inaudible)\)$/i.test(cleaned)) return "";
  if (/^\[(bell chimes|silence|music|background noise|inaudible)\]$/i.test(cleaned)) return "";
  return cleaned;
}

function collapseTranscriptItems(items) {
  const collapsed = [];
  for (const item of items) {
    const previous = collapsed[collapsed.length - 1];
    const startsNewThought = /^[A-Z0-9]/.test(item.text) || /^(Okay|All right|So|Yeah|No|Yes|And|But|Right)\b/i.test(item.text);
    if (previous && previous.text.length < 520 && !/[.!?]$/.test(previous.text) && !startsNewThought) {
      previous.text = `${previous.text} ${item.text}`;
    } else {
      collapsed.push({ ...item });
    }
  }
  return collapsed;
}

async function runPrepMode() {
  const payload = getMeetingPayload();
  prepOutput.textContent = "Pulling local notes...";
  showTab("prep");
  const result = await api("/api/meetings/prep-session/prep", {
    method: "POST",
    body: JSON.stringify(payload)
  });
  prepOutput.textContent = result.prep;
}

async function runCalendarMatch() {
  const payload = getMeetingPayload();
  const result = await api("/api/meetings/prep-session/calendar-match", {
    method: "POST",
    body: JSON.stringify({ ...payload, startTime: new Date().toISOString() })
  });
  prepOutput.textContent = [
    "# Calendar Match",
    "",
    result.matches.length
      ? result.matches.map((event) => [
          `- ${event.warning ? "Warning" : event.summary} · ${formatEastern(event.start)} ET · ${event.source}`,
          event.calendar ? `  Calendar: ${event.calendar}` : "",
          event.location ? `  Location: ${event.location}` : "",
          event.attendees?.length ? `  Attendees: ${event.attendees.join(", ")}` : "",
          event.description ? `  Notes: ${String(event.description).slice(0, 240).replace(/\s+/g, " ")}` : ""
        ].filter(Boolean).join("\n")).join("\n\n")
      : "No matching calendar events found near the current time."
  ].join("\n");
  showTab("prep");
}

function getMeetingPayload() {
  return {
    title: $("#title").value,
    client: $("#client").value,
    attendees: $("#attendees").value,
    platform: $("#platform").value,
    notes: $("#notes").value,
    consent: $("#consent").checked
  };
}

function loadK2Preset() {
  $("#title").value = "K2 Project Development Meeting";
  $("#client").value = "K2 Renew";
  $("#attendees").value = "K2 project development team";
  $("#platform").value = "Zoom";
  $("#notes").value = [
    "Weekly K2 project development meeting.",
    "Run order is Erin Norris, then Scott Morton, then Sona Tufenkian.",
    "Capture project IDs, SLR updates, partner movement, next actions, owners, blockers, contract/GIS/data requests, and leadership decisions.",
    "Watch for changes to project status, date entered status, days in status, project category, partner-designated project type, acreage, target acres, and acreage fit.",
    "Do not treat On Radar/On Radar projects, parked/on-hold/remove/do-not-pursue items, or stale pre-creation contact dates as meeting action items.",
    "After the call, Finalize Transcript and review the K2 action package before updating dashboard/ClickUp."
  ].join("\n");
}

function clearPreset() {
  $("#title").value = "";
  $("#client").value = "";
  $("#attendees").value = "";
  $("#platform").value = "Independent";
  $("#notes").value = "";
}

function applyUrlPreset() {
  const params = new URLSearchParams(window.location.search);
  if (params.get("preset") === "k2-project-development") {
    loadK2Preset();
  }
}

function renderRecordingEvents(items) {
  recordingOutput.innerHTML = items.length ? "" : '<div class="empty-state">No recording events yet.</div>';
  [...items].reverse().forEach((item) => {
    const line = document.createElement("div");
    line.className = "transcript-line";
    line.innerHTML = formatTranscriptLine(item);
    recordingOutput.appendChild(line);
  });
}

function formatTranscriptLine(item) {
  const body = item.text
    ? escapeHtml(item.text).replace(/\n/g, "<br>")
    : `<span class="warning">${escapeHtml(item.warning || "Saved without transcription.")}</span>`;
  return `<time>${new Date(item.at || Date.now()).toLocaleTimeString()} · ${escapeHtml(item.provider || "local")}</time><div>${body}</div>`;
}

function renderMeetingFiles(meeting) {
  const base = `data/meetings/${meeting.id}`;
  fileOutput.innerHTML = `
    <div class="file-grid">
      <div class="file-tile"><strong>Folder</strong><br>${escapeHtml(base)}</div>
      <div class="file-tile"><strong>System Audio</strong><br>${escapeHtml(meeting.files.systemAudio || "Not saved yet")}</div>
      <div class="file-tile"><strong>Microphone Audio</strong><br>${escapeHtml(meeting.files.microphoneAudio || "Not saved yet")}</div>
      <div class="file-tile"><strong>Recording</strong><br>${escapeHtml(meeting.files.recording || "Not saved yet")}</div>
      <div class="file-tile"><strong>Transcript</strong><br>${escapeHtml(meeting.files.transcript)}</div>
      <div class="file-tile"><strong>Speaker JSON</strong><br>${escapeHtml(meeting.files.diarized)}</div>
      <div class="file-tile"><strong>Brief</strong><br>${escapeHtml(meeting.files.brief)}</div>
      <div class="file-tile"><strong>Action Package</strong><br>${escapeHtml(meeting.files.actionPackage || "Not generated")}</div>
    </div>
  `;
}

function setNativeStatus(message, mode = "") {
  const status = $("#native-status");
  status.textContent = message;
  status.classList.toggle("ready", mode === "ready");
  status.classList.toggle("error", mode === "error");
}

function clearEmptyRecording() {
  if (recordingOutput.querySelector(".empty-state")) recordingOutput.innerHTML = "";
}

function updateTimer() {
  const elapsed = state.startedAt ? Math.max(0, Date.now() - state.startedAt) : 0;
  const total = Math.floor(elapsed / 1000);
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  $("#recording-timer").textContent = `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function formatEastern(value) {
  return new Date(value).toLocaleString("en-US", {
    timeZone: DISPLAY_TIME_ZONE,
    month: "numeric",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit"
  });
}

function showTab(name) {
  document.querySelector(`.tabs button[data-tab="${name}"]`)?.click();
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options
  });
  const json = await response.json();
  if (!response.ok) throw new Error(json.error || "Request failed");
  return json;
}

function escapeHtml(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
